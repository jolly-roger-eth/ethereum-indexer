export type JSONObject = {
  [key: string]: JSONType;
};

export type JSONType = string | number | boolean | JSONType[] | JSONObject;
