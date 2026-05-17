import {
  addition,
  subtraction,
  multiplication,
  division,
} from "../method/index.js";

export class Calculator {
  constructor() {
    this.addition = addition;
    this.subtraction = subtraction;
    this.multiplication = multiplication;
    this.division = division;
  }
}
