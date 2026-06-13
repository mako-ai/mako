/**
 * Minimal OpenAPI 3.1 type surface used by the generator. Intentionally narrow
 * — only the fields we actually emit are modelled, with `JsonSchema` left open.
 */

export type JsonSchema = Record<string, unknown>;

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface OpenApiMediaType {
  schema: JsonSchema;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

export type OpenApiPathItem = Partial<
  Record<"get" | "post" | "put" | "delete" | "patch", OpenApiOperation>
>;

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: Array<{ url: string; description?: string }>;
  tags: OpenApiTag[];
  security: Array<Record<string, string[]>>;
  paths: Record<string, OpenApiPathItem>;
  components: {
    securitySchemes: Record<string, JsonSchema>;
  };
}
