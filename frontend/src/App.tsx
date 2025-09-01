/* eslint-disable @typescript-eslint/no-unused-vars */
import { Login } from "../src/components/login";
import { ThemeProvider } from "./providers/theme-provider";
import { useState } from "react";
import { type User } from "stream-chat";

const USER_STORAGE_KEY = "chat-ai-app-user";

function App() {
  const [user, setUser] = useState<User | null>(() => {
    const savedUser = localStorage.getItem(USER_STORAGE_KEY);
    return savedUser ? JSON.parse(savedUser) : null;
  });

  const handleUserLogin = (authenticatedUser: User) => {
    const avatarUrl = `https://api.dicebear.com/9.x/avataaars/svg?seed=${authenticatedUser.name}`;
    const userWithImage = {
      ...authenticatedUser,
      image: avatarUrl, 
    };
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userWithImage));
    setUser(userWithImage);
  };

  const handleLogout = () => {
    localStorage.removeItem(USER_STORAGE_KEY);
    setUser(null);
  };

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <div className="h-screen bg-background">
        <Login onLogin={handleLogout} />
      </div>
    </ThemeProvider>
  )
}

export default App;
