const fs = require("fs");
const path = require("path");
const Module = require("module");

const parts = [1, 2, 3].map(index =>
  fs.readFileSync(path.join(__dirname, `main-v13.part${index}.jsfrag`), "utf8")
);
const compiled = new Module(path.join(__dirname, "main-v13.js"), module);
compiled.filename = path.join(__dirname, "main-v13.js");
compiled.paths = module.paths;
compiled._compile(parts.join(""), compiled.filename);
