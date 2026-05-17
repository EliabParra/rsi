export const quadratic = async function ({ a, b, c }) {
  try {
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) {
      throw new Error("No real roots");
    }
    const sqrtDiscriminant = Math.sqrt(discriminant);
    const root1 = (-b + sqrtDiscriminant) / (2 * a);
    const root2 = (-b - sqrtDiscriminant) / (2 * a);
    return {
      msg: "Quadratic equation solved",
      result: [root1, root2],
    };
  } catch (err) {
    throw new Error(err.message);
  }
};
