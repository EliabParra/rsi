import MethodMapper from "./methodMapper.js";

export default async function resolveClassInstance({ className, method }) {
  const mapper = new MethodMapper();

  if (Object.keys(mapper.getMethodMap() || {}).length === 0) {
    await mapper.initialize();
  }

  if (!mapper.hasMethod(className, method)) {
    return `Ruta inválida: El método '${method}' no existe en la clase '${className}'`;
  }

  const classKey =
    mapper.findKeyIgnoreCase(mapper.getMethodMap(), className) || className;
  const methodMap = classKey ? mapper.getMethodMap()[classKey] : undefined;
  const methodKey = mapper.findKeyIgnoreCase(methodMap, method) || method;

  try {
    const modulePath = `./class/${classKey}.js`;
    const module = await import(modulePath);

    const ClassRef = module[className] || module.default;

    if (!ClassRef || typeof ClassRef !== "function") {
      throw new Error(
        `El módulo '${className}' cargado no exporta una clase válida.`,
      );
    }

    const classInstance = new ClassRef();

    if (
      methodKey &&
      methodKey !== method &&
      typeof classInstance[methodKey] === "function"
    ) {
      classInstance[method] = classInstance[methodKey].bind(classInstance);
    }
    return classInstance;
  } catch (error) {
    console.error("Error crítico en resolveClassInstance:", error);
    return `Error interno al cargar la instancia de ejecución: ${error.message}`;
  }
}
