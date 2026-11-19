import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./pose/harness";
import "@fontsource-variable/inter";
import "@fontsource-variable/mulish";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
