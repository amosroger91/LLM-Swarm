import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readRequired(name) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) fail(`Missing ${name} in ${root}`);
  return fs.readFileSync(file, "utf8");
}

const html = readRequired("index.html");
const css = readRequired("site.css");
const source = readRequired("site.js");

if (!html.includes("Swarm Test Site")) fail("index.html must contain the text Swarm Test Site");
if (!html.includes("site.css")) fail("index.html must load site.css");
if (!html.includes("site.js")) fail("index.html must load site.js");

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicates.length > 0) {
  fail(
    `Duplicate id attributes: ${duplicates.join(", ")}. Use id="name" only on the text input, id="greet" only on the button, and id="greeting" only on the element that receives the hello text.`,
  );
}

const tags = [...html.matchAll(/<(input|button|p|span|h1|label|textarea)\b([^>]*)>/gi)].map(
  (match) => ({
    tag: match[1].toLowerCase(),
    attrs: match[2] ?? "",
    id: /\bid=["']([^"']+)["']/i.exec(match[2] ?? "")?.[1] ?? "",
  }),
);
const nameTag = tags.find((tag) => tag.id === "name");
const greetTag = tags.find((tag) => tag.id === "greet");
const greetingTag = tags.find((tag) => tag.id === "greeting");
if (!nameTag || nameTag.tag !== "input") fail('id="name" must be the text input');
if (!greetTag || greetTag.tag !== "button") fail('id="greet" must be the button');
if (!greetingTag) fail('id="greeting" is missing');

function ruleBackground(block) {
  return /background(?:-color)?\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim() ?? "";
}

function buttonBackgroundColor(styleText, buttonAttrs) {
  const classes = /\bclass=["']([^"']+)["']/i.exec(buttonAttrs)?.[1]?.split(/\s+/) ?? [];
  for (const match of styleText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((selector) => selector.trim());
    const background = ruleBackground(match[2] ?? "");
    if (!background) continue;
    const applies = selectors.some((selector) => {
      if (selector === "button" || selector === "#greet") return true;
      if (selector.startsWith(".") && classes.includes(selector.slice(1))) return true;
      return false;
    });
    if (applies) return background;
  }
  return "";
}

const bodyRule = /(?:^|})\s*body\s*\{([^}]*)\}/i.exec(css)?.[1] ?? "";
const bodyBackground = ruleBackground(bodyRule);
const buttonBackground = buttonBackgroundColor(css, greetTag.attrs);
if (!bodyBackground) fail("site.css must set a background color on body");
if (/^(#fff|#ffffff|white)$/i.test(bodyBackground)) {
  fail("The page background must be a color other than white");
}
if (!buttonBackground || buttonBackground.toLowerCase() === bodyBackground.toLowerCase()) {
  fail(
    "The Greet button needs its own background color. Put it on the button, on #greet, or on a class that the button element actually uses.",
  );
}
const fontSize = Number(/font-size\s*:\s*(\d+)px/i.exec(css)?.[1] ?? "0");
if (fontSize < 16) fail("The paragraph and greeting need a font size of at least 16px");

function makeElement(tag, id) {
  let onclickHandler = null;
  const element = {
    tag,
    id,
    value: "",
    textContent: "",
    listeners: {},
    addEventListener(type, handler) {
      element.listeners[type] = handler;
    },
    click() {
      element.listeners.click?.();
      if (typeof onclickHandler === "function") onclickHandler.call(element);
    },
  };
  Object.defineProperty(element, "onclick", {
    get() {
      return onclickHandler;
    },
    set(handler) {
      onclickHandler = handler;
    },
  });
  Object.defineProperty(element, "innerText", {
    get() {
      return element.textContent;
    },
    set(value) {
      element.textContent = String(value);
    },
  });
  return element;
}

const elements = tags.map((tag) => makeElement(tag.tag, tag.id));
const document = {
  getElementById(id) {
    return elements.find((element) => element.id === id) ?? null;
  },
  querySelector(selector) {
    const id = /#([A-Za-z0-9_-]+)/.exec(selector)?.[1];
    const tag = /^([a-z]+)#/i.exec(selector)?.[1]?.toLowerCase();
    if (!id) return null;
    return elements.find((element) => element.id === id && (!tag || element.tag === tag)) ?? null;
  },
  addEventListener(type, handler) {
    if (type === "DOMContentLoaded" || type === "load") handler();
  },
};
const context = { document, window: { document, addEventListener: document.addEventListener } };
try {
  vm.runInNewContext(source, context, { filename: "site.js" });
} catch (error) {
  fail(`site.js threw while loading: ${error instanceof Error ? error.message : String(error)}`);
}

const button = document.getElementById("greet");
const input = document.getElementById("name");
const greeting = document.getElementById("greeting");
if (!button || !input || !greeting)
  fail("site.js could not see the name, greet, and greeting elements");

function clickExpect(value, expected) {
  input.value = value;
  try {
    button.click();
  } catch (error) {
    fail(
      `Clicking Greet threw (${error instanceof Error ? error.message : String(error)}). Read the input with id name and write the result into the element with id greeting.`,
    );
  }
  if (greeting.textContent !== expected) {
    fail(
      `After entering ${JSON.stringify(value)}, #greeting was ${JSON.stringify(greeting.textContent)}. Expected ${JSON.stringify(expected)}.`,
    );
  }
}

clickExpect("", "Hello, stranger");
clickExpect("   ", "Hello, stranger");
clickExpect("Ada", "Hello, Ada");
clickExpect("  Ada  ", "Hello, Ada");
process.stdout.write("site check passed\n");
