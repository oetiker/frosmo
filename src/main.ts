import "./styles.css";

import { App } from "./app/app.js";
import { aboutScreen } from "./app/screens/about.js";
import { calibrateScreen } from "./app/screens/calibrate.js";
import { homeScreen } from "./app/screens/home.js";
import { labScreen } from "./app/screens/lab.js";
import { playScreen } from "./app/screens/play.js";
import { printScreen } from "./app/screens/print.js";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");

const app = new App(root);
app.register("home", () => homeScreen());
app.register("calibrate", () => calibrateScreen());
app.register("play", (arg) => playScreen(arg));
app.register("lab", () => labScreen());
app.register("print", () => printScreen());
app.register("about", () => aboutScreen());

const start = app.initialScreen();
app.go(start.name, start.arg);

// Safari on iPadOS still zooms on a double tap and pinches the whole page,
// both of which ruin a game where tapping and holding pieces is the input.
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener(
  "dblclick",
  (e) => {
    if ((e.target as HTMLElement).closest(".play, .cal-stage")) e.preventDefault();
  },
  { passive: false },
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch(() => {
      // An unregistrable worker costs offline play, not the app: carry on.
    });
  });
}
