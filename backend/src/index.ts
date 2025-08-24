import cors from "cors";
import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// Start the Express Server 
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
