const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const postcss = require("postcss");
const selectorParser = require("postcss-selector-parser");
const prettier = require("prettier");

const filename = path.join(__dirname, "..", "public", "style.css");

test("stylesheet has valid selectors and no duplicated rule or property definitions", () => {
  const root = postcss.parse(fs.readFileSync(filename, "utf8"));
  const rules = new Set();
  root.walkRules(rule => {
    const parents = [];
    for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
      parents.unshift(`${parent.name}:${parent.params}`);
    }
    const selector = selectorParser().processSync(rule.selector, { lossless: false });
    const key = `${parents.join("|")}|${selector}`;
    assert.equal(rules.has(key), false, `Repeated rule: ${key}`);
    rules.add(key);
    const properties = new Set();
    for (const declaration of rule.nodes.filter(node => node.type === "decl")) {
      const property = `${declaration.prop}|${!!declaration.important}`;
      assert.equal(properties.has(property), false, `Repeated property: ${selector} ${property}`);
      properties.add(property);
    }
  });
});

test("stylesheet stays formatted with ten documented style sections", async () => {
  const css = fs.readFileSync(filename, "utf8");
  assert.equal(await prettier.check(css, { parser: "css", tabWidth: 2, printWidth: 100 }), true);
  assert.equal([...css.matchAll(/\/\* \d{2}\. /g)].length, 10);
});

test("obsolete channel styles are absent and management button styles are scoped", () => {
  const root = postcss.parse(fs.readFileSync(filename, "utf8"));
  const obsolete = new Set(["responsive-safe-area", "active-wemos-channel", "active-channel-title", "managed-set-actions"]);
  let scopedButtons = false;
  root.walkRules(rule => {
    selectorParser(selectors => selectors.walkClasses(node => {
      assert.equal(obsolete.has(node.value), false, `Obsolete style: ${node.value}`);
    })).processSync(rule.selector);
    if (rule.selector === ".wemos-channel-table .button-group") scopedButtons = true;
    assert.notEqual(rule.selector, ".button-group");
  });
  assert.equal(scopedButtons, true);
});

test("shared palettes and typography keep page-specific aliases in one design system", () => {
  const root = postcss.parse(fs.readFileSync(filename, "utf8"));
  const find = selector => root.nodes.find(node => node.type === "rule" && node.selector === selector);
  const palette = find(":root");
  const dark = find('html[data-theme="dark"]');
  assert.ok(palette);
  assert.ok(dark);
  for (const [selector, prefix] of [[".wemos-page", "--wemos-"], ["body:not(.wemos-page)", "--site-"]]) {
    const rule = find(selector);
    assert.ok(rule);
    for (const declaration of rule.nodes.filter(node => node.type === "decl" && node.prop.startsWith(prefix))) {
      const shared = `--factory-${declaration.prop.slice(prefix.length)}`;
      assert.equal(declaration.value, `var(${shared})`);
      assert.ok(palette.nodes.some(node => node.prop === shared));
      assert.ok(dark.nodes.some(node => node.prop === shared));
    }
    assert.equal(rule.nodes.find(node => node.prop === "font-family").value, "var(--factory-font-family)");
  }
});