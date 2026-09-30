/**
 * Browsers draw a rectangular focus outline on every `<input>`, and
 * react-native-web renders each `TextInput` as one. The phone app never draws
 * it, and our `Input` already shows focus with its own border — so in the web
 * build the browser's box is a second border that does not match anything.
 */
const style = document.createElement("style");

style.textContent = "input:focus, textarea:focus { outline: none; }";
document.head.appendChild(style);
