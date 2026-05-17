export const subtraction = async function ({ a, b }) {
  try {
    return {
      msg: "Subtraction successful",
      result: a - b,
    };
  } catch (err) {
    throw new Error(err.message);
  }
};
