import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs";

export default class MethodMapper {
  static instance;

  constructor() {
    if (MethodMapper.instance) return MethodMapper.instance;

    const filename = path.dirname(fileURLToPath(import.meta.url));
    this.classesPath = path.resolve(filename, "./class");
    this.methodMap = {};

    MethodMapper.instance = this;
  }

  async initialize() {
    let files = [];

    try {
      files = fs.readdirSync(this.classesPath);
    } catch (err) {
      console.error(
        `Error leyendo la carpeta de clases en ${this.classesPath}`,
        err,
      );
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".js")) continue;

      const className = path.basename(file, ".js");
      this.methodMap[className] = {};

      try {
        const moduleUrl = pathToFileURL(path.join(this.classesPath, file));
        const module = await import(moduleUrl.href);
        const ClassRef = module[className];

        if (typeof ClassRef === "function") {
          const classInstance = new ClassRef();

          const instanceMethods = Object.keys(classInstance);
          const protoMethods = Object.getOwnPropertyNames(
            Object.getPrototypeOf(classInstance),
          ).filter((name) => name !== "constructor");

          for (const methodName of [...instanceMethods, ...protoMethods]) {
            if (typeof classInstance[methodName] === "function") {
              this.methodMap[className][methodName] = true;
            }
          }
        }
      } catch (err) {
        console.error(
          `Error procesando los métodos para la clase ${file}:`,
          err,
        );
      }
    }
  }

  findKeyIgnoreCase(target, requestedKey) {
    if (!target || typeof requestedKey !== "string") return undefined;
    return Object.keys(target).find(
      (key) => key.toLowerCase() === requestedKey.toLowerCase(),
    );
  }

  hasMethod(className, functionName) {
    const classKey = this.findKeyIgnoreCase(this.methodMap, className);
    const methodMap = classKey ? this.methodMap[classKey] : undefined;

    const methodKey = this.findKeyIgnoreCase(methodMap, functionName);
    return !!methodKey;
  }

  getMethodMap() {
    return this.methodMap;
  }
}
