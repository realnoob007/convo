import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { applyPreferences, readPreferences } from "./lib/preferences";

applyPreferences(readPreferences());
createRoot(document.getElementById("root")!).render(<App />);
