export type { Message } from "../store/lib/types";

export interface Collection {
  id: string;
  name: string;
  description?: string;
  sampleDocument: any;
  sampleDocuments?: any[];
  schemaInfo?: any;
  documentCount: number;
}

export interface View {
  id: string;
  name: string;
  viewOn: string;
  pipeline: any[];
  description?: string;
}

export interface Definition {
  id: string;
  name: string;
  type: "function" | "class" | "interface" | "type";
  content: string;
  fileName: string;
  lineNumbers: string;
}

export interface ChatProps {
  currentEditorContent?: {
    content: string;
    fileName?: string;
    language?: string;
  };
  onSwitchToCollections?: () => void;
}
