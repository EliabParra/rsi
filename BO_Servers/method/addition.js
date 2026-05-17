export const addition = async function ({ a, b }) {
  try {
    return {
      msg: "Addition successful",
      result: a + b,
    };
  } catch (err) {
    throw new Error(err.message);
  }
};
