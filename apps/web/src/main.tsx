import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./tokens.css";
import "./app.css";
import { App } from "./App.js";

// Collected so scripts/ui-check.ts can assert a clean console; harmless in production.
declare global {
  interface Window { __uiErrors?: string[] }
}
window.__uiErrors = [];
window.addEventListener("error", (e) => window.__uiErrors!.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__uiErrors!.push(String(e.reason)));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
