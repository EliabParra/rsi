export const multiplication = async function ({ a, b }) {
  try {
    return {
      msg: "Multiplication successful",
      result: a * b,
    };
  } catch (err) {
    throw new Error(err.message);
  }
};
