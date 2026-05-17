export const division = async function ({ a, b }) {
  try {
    if (b !== 0) {
      return {
        msg: "Division successful",
        result: a / b,
      };
    }
    throw new Error("Division by zero is not allowed");
  } catch (err) {
    throw new Error(err.message);
  }
};
