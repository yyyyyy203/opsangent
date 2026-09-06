export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const randomIdGenerator: IdGenerator = {
  next: (prefix) => `${prefix}_${crypto.randomUUID()}`,
};
