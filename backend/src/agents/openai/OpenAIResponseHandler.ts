import OpenAI from "openai";
import type { AssistantStream } from "openai/lib/AssistantStream";
import type { Channel, Event, MessageResponse, StreamChat } from "stream-chat";

export class OpenAIResponseHandler {
    private message_text = "";
    private chunk_counter = 0;
    private run_id = "";
    private is_done = false;
    private last_update_time = 0;

    constructor(
        private readonly openai: OpenAI,
        private readonly openAiThread: OpenAI.Beta.Threads.Thread,
        private readonly assistantStream: AssistantStream,
        private readonly chatClient: StreamChat,
        private readonly channel: Channel,
        private readonly message: MessageResponse,
        private readonly onDispose: () => void 
    ) {
        this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
    }

    run = async () => {
        const { cid, id: message_id } = this.message;
        let isCompleted = false;
        let toolOutputs = [];
        let currentStream: AssistantStream = this.assistantStream;

        try {
            while (!isCompleted) {
                for await (const event of currentStream) {
                    this.handleStreamEvent(event);

                    if (
                        event.event === "thread.run.requires_action" &&
                        event.data.required_action?.type === "submit_tool_outputs"
                    ) {
                        this.run_id = event.data.id;
                        await this.channel.sendEvent({
                            type: "ai_indicator.update",
                            ai_state: "AI_STATE_EXTERNAL_SOURCES",
                            cid: cid,
                            message_id: message_id,
                        });
                        const toolCalls =
                            event.data.required_action.submit_tool_outputs.tool_calls;
                        toolOutputs = [];

                        for (const toolCall of toolCalls) {
                            if (toolCall.function.name === "web_search") {
                                try {
                                    const args = JSON.parse(toolCall.function.arguments);
                                    const searchResult = await this.performWebSearch(args.query);
                                    toolOutputs.push({
                                        tool_call_id: toolCall.id,
                                        output: searchResult,
                                    });
                                } catch (e) {
                                    console.error(
                                        "Error parsing tool arguements or performing web search",
                                        e
                                    );
                                    toolOutputs.push({
                                        tool_call_id: toolCall.id,
                                        output: JSON.stringify({ error: "Failed to call tool"}),
                                        });
                                        }
                                    }
                                }
                                // Exit the inner loop to submit tool outputs 
                                break;
                            }

                            if (event.event === "thread.run.completed") {
                                isCompleted = true;
                                break; // Exit the inner loop 
                            }

                            if (event.event === "thread.run.failed") {
                                isCompleted = true;
                                await this.handleError(
                                    new Error(event.data.last_error?.message ?? "Run failed")
                                );
                                break; // Exit the inner loop 
                            }
                        }

                        if (isCompleted) {
                            break; // Exit the while loop 
                        }

                        if (toolOutputs.length > 0) {
                            currentStream = this.openai.beta.threads.runs.submitToolOutputsStream(
                                this.openAiThread.id,
                                this.run_id,
                                { tool_outputs: toolOutputs }
                            );
                            toolOutputs = []; // Reset tool outputs 
                        }
                    }
                } catch (error) {
                    console.error("An error occured during the run:", error);
                    await this.handleError(error as Error);
                } finally {
                    await this.dispose();
                }
            };

            dispose = async () => {
                if (this.is_done) {
                    return;
                }
                this.is_done = true;
                this.chatClient.off("ai_indicator.stop", this.handleStopGenerating);
                this.onDispose();
            };

            private handleStopGenerating = async (event: Event) => {
                if (this.is_done || event.message_id !== this.message.id) {
                    return;
                }

                console.log("Stop generating for message", this.message.id);
                if (!this.openai || !this.openAiThread || !this.run_id) {
                    return;
                }

                try {
                    await this.openai.beta.threads.runs.cancel(
                        this.openAiThread.id,
                        this.run_id
                    );
                } catch (e) {
                    console.error("Error cancelling run", e);
                }

                await this.channel.sendEvent({
                    type: "ai_indicator.clear",
                    cid: this.message.cid,
                    message_id: this.message.id,
                });
                await this.dispose();
            };

            private handleStreamEvent = (
                event: OpenAI.Beta.Assistants.AssistantStreamEvent
            ) => {
                const { cid, id } = this.message;

                if (event.event === "thread.run.created") {
                    this.run_id = event.data.id;
                } else if (event.event === "thread.message.delta") {
                    const textDelta = event.data.delta.content?.[0];
                    if (textDelta?.type === "text" && textDelta.text) {
                        this.message_text += textDelta.text.value || "";
                        const now = Date.now();
                        if (now - this.last_update_time > 1000) {
                            this.chatClient.partialUpdateMessage(id, {
                                set: { text: this.message_text },
                            });
                            this.last_update_time = now;
                        }
                        this.chunk_counter += 1;
                    }
                } else if (event.event === "thread.message.completed") {
                    this.chatClient.partialUpdateMessage(id, {
                        set: {
                            text:
                            event.data.content[0].type === "text"
                                ? event.data.content[0].text.value
                                : this.message_text, 
                        },
                    });
                    this.channel.sendEvent({
                        type: "ai_indicator.clear",
                        cid: cid,
                        message_id: id,
                    });
                } else if (event.event === "thread.run.step.created") {
                    if (event.data.step_details.type === "message_creation") {
                        this.channel.sendEvent({
                            type: "ai_indicator.update",
                            ai_state: "AI_STATE_GENERATING",
                            cid: cid,
                            message_id: id, 
                        });
                    }
                }
            };

            private handleError = async (error: Error) => {
                if (this.is_done) {
                    return;
                } 
                await this.channel.sendEvent({
                    type: "ai_indicator.update",
                    ai_state: "AI_STATE_ERROR",
                    cid: this.message.cid,
                    message_id: this.message.id, 
                });
                await this.chatClient.partialUpdateMessage(this.message.id, {
                    set: {
                        text: error.message ?? "Error generating the message",
                       // message: error.toString(),
                    },
                });
                await this.dispose();
            };

            private performWebSearch = async (query: string): Promise<string> => {
                const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

                if (!TAVILY_API_KEY) {
                    return JSON.stringify({
                        error: "Web search is not available. API key not configured.",
                    });
                }

                console.log(`Performing web search for: "${query}"`);

                try {
                    const response = await fetch("https://api.tavily.com/search", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${TAVILY_API_KEY}`,
                        },
                        body: JSON.stringify({
                            query: query,
                            search_depth: "advanced",
                            max_results: 5,
                            include_answer: true,
                            include_raw_content: false, 
                        }),
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(`Tavily search failed for query "${query}":`, errorText);
                        return JSON.stringify({
                            error: `Search failed with status: ${response.status}`,
                            details: errorText, 
                        });
                    }

                    const data = await response.json();
                    console.log(`Tavily search successful for query "${query}"`);

                    return JSON.stringify(data);
                } catch (error) {
                    console.error(
                        `An exception occured during web search for "${query}":`,
                        error
                    );
                    return JSON.stringify({
                        error: "An exception occurred during the search.",
                        message: error instanceof Error ? error.message : "Unknown error", 
                    });
                }
            };
        }