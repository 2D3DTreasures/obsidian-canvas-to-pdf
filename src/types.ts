export interface CanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface BaseNode {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string; // "1" to "6" or hex "#RRGGBB"
}

export interface TextNode extends BaseNode {
    type: "text";
    text: string;
}

export interface FileNode extends BaseNode {
    type: "file";
    file: string;
    subpath?: string;
}

export interface LinkNode extends BaseNode {
    type: "link";
    url: string;
}

export interface GroupNode extends BaseNode {
    type: "group";
    label?: string;
    background?: string;
    backgroundStyle?: "cover" | "ratio" | "repeat";
}

export interface CanvasEdge {
    id: string;
    fromNode: string;
    fromSide?: "top" | "right" | "bottom" | "left";
    fromEnd?: "none" | "arrow";
    toNode: string;
    toSide?: "top" | "right" | "bottom" | "left";
    toEnd?: "none" | "arrow";
    color?: string;
    label?: string;
}

export interface BoundingBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface LayoutMetrics {
    pageWidth: number;
    pageHeight: number;
    scaleFactor: number;
    margin: number;
    offsetX: number;
    offsetY: number;
}

export interface VectorPdfSettings {
    defaultExportPath: string;
    openAfterExport: boolean;
    exportFormat?: 'pdf' | 'html' | 'both';
    exportTarget?: 'pdf' | 'html';
    browserPath?: string;
    showNodeLabels: boolean;
    highResWebviews: boolean;
    nestedCanvasMode: 'outline' | 'render';
    nestedCanvasMaxDepth: number;
}

export const DEFAULT_SETTINGS: VectorPdfSettings = {
    defaultExportPath: "Exports/",
    openAfterExport: true,
    exportFormat: 'pdf',
    browserPath: '',
    showNodeLabels: true,
    highResWebviews: true,
    nestedCanvasMode: 'render',
    nestedCanvasMaxDepth: 3
}
