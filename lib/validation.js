class ValidationError extends Error {
  constructor(issues) {
    super(issues.map(({ message }) => message).join(", "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

class Schema {
  constructor(parse) {
    this.parseValue = parse;
  }

  parse(value) {
    const issues = [];
    const result = this.parseValue(value, [], issues);
    if (issues.length) throw new ValidationError(issues);
    return result;
  }

  safeParse(value) {
    try {
      return { success: true, data: this.parse(value) };
    } catch (error) {
      if (error instanceof ValidationError) return { success: false, error };
      throw error;
    }
  }

  optional() {
    return new Schema((value, path, issues) =>
      value === undefined ? undefined : this.parseValue(value, path, issues),
    );
  }
  nullable() {
    return new Schema((value, path, issues) =>
      value === null ? null : this.parseValue(value, path, issues),
    );
  }
  nullish() {
    return this.nullable().optional();
  }
  default(fallback) {
    return new Schema((value, path, issues) =>
      this.parseValue(value === undefined ? fallback : value, path, issues),
    );
  }
  refine(check, message) {
    return new Schema((value, path, issues) => {
      const before = issues.length;
      const result = this.parseValue(value, path, issues);
      if (issues.length === before && !check(result)) issue(issues, path, message);
      return result;
    });
  }
}

function issue(issues, path, message) {
  issues.push({ code: "custom", path, message });
}

function primitive(test, expected) {
  return new Schema((value, path, issues) => {
    if (!test(value)) issue(issues, path, `Expected ${expected}`);
    return value;
  });
}

function stringSchema() {
  let trim = false;
  const checks = [];
  const schema = new Schema((value, path, issues) => {
    if (typeof value !== "string") {
      issue(issues, path, "Expected string");
      return value;
    }
    const result = trim ? value.trim() : value;
    for (const check of checks) if (!check.test(result)) issue(issues, path, check.message);
    return result;
  });
  schema.trim = () => {
    trim = true;
    return schema;
  };
  schema.min = (length) => {
    checks.push({
      test: (value) => value.length >= length,
      message: `String must contain at least ${length} character(s)`,
    });
    return schema;
  };
  schema.regex = (pattern) => {
    checks.push({ test: (value) => pattern.test(value), message: "Invalid string" });
    return schema;
  };
  schema.url = () => {
    checks.push({
      test: (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      },
      message: "Invalid URL",
    });
    return schema;
  };
  schema.uuid = () => {
    checks.push({
      test: (value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
      message: "Invalid UUID",
    });
    return schema;
  };
  schema.datetime = ({ offset } = {}) => {
    checks.push({
      test: (value) => {
        const match = value.match(
          /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/,
        );
        if (!match || (!offset && match[7] !== "Z") || !Number.isFinite(Date.parse(value)))
          return false;
        const [, year, month, day] = match;
        const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        return (
          date.getUTCFullYear() === Number(year) &&
          date.getUTCMonth() === Number(month) - 1 &&
          date.getUTCDate() === Number(day)
        );
      },
      message: "Invalid datetime",
    });
    return schema;
  };
  return schema;
}

function numberSchema() {
  const checks = [];
  const schema = new Schema((value, path, issues) => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      issue(issues, path, "Expected number");
      return value;
    }
    for (const check of checks) if (!check.test(value)) issue(issues, path, check.message);
    return value;
  });
  schema.int = () => {
    checks.push({ test: Number.isInteger, message: "Expected integer" });
    return schema;
  };
  schema.min = (min) => {
    checks.push({
      test: (value) => value >= min,
      message: `Number must be greater than or equal to ${min}`,
    });
    return schema;
  };
  schema.max = (max) => {
    checks.push({
      test: (value) => value <= max,
      message: `Number must be less than or equal to ${max}`,
    });
    return schema;
  };
  schema.positive = () => {
    checks.push({ test: (value) => value > 0, message: "Number must be greater than 0" });
    return schema;
  };
  schema.nonnegative = () => {
    checks.push({
      test: (value) => value >= 0,
      message: "Number must be greater than or equal to 0",
    });
    return schema;
  };
  return schema;
}

function arraySchema(item) {
  const checks = [];
  const schema = new Schema((value, path, issues) => {
    if (!Array.isArray(value)) {
      issue(issues, path, "Expected array");
      return value;
    }
    for (const check of checks) if (!check.test(value)) issue(issues, path, check.message);
    return value.map((entry, index) => item.parseValue(entry, [...path, index], issues));
  });
  schema.min = (length) => {
    checks.push({
      test: (value) => value.length >= length,
      message: `Array must contain at least ${length} element(s)`,
    });
    return schema;
  };
  return schema;
}

function objectSchema(shape, passthrough = false) {
  const schema = new Schema((value, path, issues) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issue(issues, path, "Expected object");
      return value;
    }
    const result = passthrough ? { ...value } : {};
    for (const [key, field] of Object.entries(shape)) {
      const parsed = field.parseValue(value[key], [...path, key], issues);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result;
  });
  schema.passthrough = () => objectSchema(shape, true);
  return schema;
}

// ponytail: This covers only Zod methods used by the Hatchable source port; add methods only when a port needs them.
export const z = {
  string: stringSchema,
  number: numberSchema,
  boolean: () => primitive((value) => typeof value === "boolean", "boolean"),
  unknown: () => new Schema((value) => value),
  literal: (expected) => primitive((value) => value === expected, JSON.stringify(expected)),
  enum: (values) => primitive((value) => values.includes(value), values.join(" | ")),
  array: arraySchema,
  object: objectSchema,
  union: (schemas) =>
    new Schema((value, path, issues) => {
      for (const schema of schemas) {
        const result = schema.safeParse(value);
        if (result.success) return result.data;
      }
      issue(issues, path, "Invalid input");
      return value;
    }),
  record: (_keySchema, valueSchema) =>
    new Schema((value, path, issues) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        issue(issues, path, "Expected record");
        return value;
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          valueSchema.parseValue(entry, [...path, key], issues),
        ]),
      );
    }),
};
