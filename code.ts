"use strict";

// Exibe a UI do plugin
figma.showUI(__html__, { width: 360, height: 460 });

// Variáveis de estado
let analyzedFrames: (FrameNode | ComponentNode | InstanceNode)[] = [];
let selectingFromUI = false;
let showHiddenElements = false;

/* ---------- HELPERS ---------- */

// Converte cor RGB para HEX
function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// Type guard para SceneNode
function isSceneNode(node: BaseNode): node is SceneNode {
    return node.type !== "DOCUMENT" && node.type !== "PAGE";
}

// Type guard para Gradients
function isGradientPaint(p: Paint): p is GradientPaint {
    return (
        p.type === "GRADIENT_LINEAR" ||
        p.type === "GRADIENT_RADIAL" ||
        p.type === "GRADIENT_ANGULAR" ||
        p.type === "GRADIENT_DIAMOND"
    );
}

// Prefixos válidos de tokens
const VALID_TOKEN_PREFIXES = [
    "Base Color/",
    "Contextual Color/",
    "Base/",
    //"Primary/",
    "Surface Colors/",
    "Content Colors/",
    "Brand Colors/"
];

// Verifica se um paint tem token válido (agora assíncrono)
async function hasValidColorToken(node: SceneNode, paint: Paint): Promise<boolean> {
    // 1️⃣ Variable (verificação segura)
    if (paint.type === "SOLID") {
        if ("boundVariables" in paint && paint.boundVariables && "color" in paint.boundVariables) {
            return true;
        }
    }

    // 2️⃣ Fill Style
    if (!paint.type.startsWith("GRADIENT") && "fillStyleId" in node) {
        const styleId = node.fillStyleId;
        if (typeof styleId === "string" && styleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                if (style) {
                    return VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix));
                }
            } catch (e) {
                // Style não encontrado, continua
            }
        }
    }

    // 3️⃣ Stroke Style
    if (!paint.type.startsWith("GRADIENT") && "strokeStyleId" in node) {
        const styleId = node.strokeStyleId;
        if (typeof styleId === "string" && styleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                if (style) {
                    return VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix));
                }
            } catch (e) {
                // Style não encontrado, continua
            }
        }
    }

    return false;
}

/* ---------- CORE ---------- */

async function analyzeFrames(frames: (FrameNode | ComponentNode | InstanceNode)[]) {
    analyzedFrames = frames;

    const map = new Map<string, { nodeId: string; paint: Paint; isStroke: boolean; node: SceneNode }[]>();

    async function processPaint(node: SceneNode, p: Paint, isStroke: boolean) {
        if (!p || p.visible === false) return;
        if (p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") return;
        
        // Verifica token de forma assíncrona
        if (p.type === "SOLID" && await hasValidColorToken(node, p)) return;

        let key: string;
        if (p.type === "SOLID") key = `SOLID_${rgbToHex(p.color)}_${p.opacity != null ? p.opacity : 1}`;
        else if (isGradientPaint(p)) key = `GRADIENT_${JSON.stringify(p.gradientStops)}`;
        else return;

        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, paint: p, isStroke, node });
    }

    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        // Processar fills e strokes do nó atual
        if ("fills" in node && Array.isArray(node.fills)) {
            for (const p of node.fills) {
                await processPaint(node, p, false);
            }
        }
        if ("strokes" in node && Array.isArray(node.strokes)) {
            for (const p of node.strokes) {
                await processPaint(node, p, true);
            }
        }

        // Percorrer filhos de todos os tipos de nós, incluindo INSTANCE
        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    // Processar todos os frames
    for (const frame of frames) {
        await walk(frame);
    }

    const groups = Array.from(map.values()).map(nodePaints => {
        const firstPaint = nodePaints[0].paint;
        return { hex: firstPaint.type === "SOLID" ? rgbToHex(firstPaint.color) : "Gradiente", nodePaints };
    });

    figma.ui.postMessage({ type: "result", groups });
}

/* ---------- EVENTS ---------- */

figma.on("selectionchange", () => {
    if (selectingFromUI) return;
    const validNodes = figma.currentPage.selection.filter(
        (n): n is FrameNode | ComponentNode | InstanceNode => 
            n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
    );
    if (validNodes.length) analyzeFrames(validNodes);
    else figma.ui.postMessage({ type: "empty" });
});

// Mensagens vindas da UI
figma.ui.onmessage = async (msg) => {
    selectingFromUI = true;

    if (msg.type === "select-node") {
        try {
            const node = await figma.getNodeByIdAsync(msg.nodeId);
            if (node && isSceneNode(node)) {
                figma.currentPage.selection = [node];
                figma.viewport.scrollAndZoomIntoView([node]);
            } else console.warn("Node inválido:", node);
        } catch (err) {
            console.error("Erro ao buscar node:", err);
        }
    }

    if (msg.type === "select-multiple-nodes") {
        try {
            const nodes = await Promise.all(msg.nodeIds.map((id: string) => figma.getNodeByIdAsync(id)));
            const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));
            if (validNodes.length) {
                figma.currentPage.selection = validNodes;
                figma.viewport.scrollAndZoomIntoView(validNodes);
            } else console.warn("Nenhum node válido encontrado:", msg.nodeIds);
        } catch (err) {
            console.error("Erro ao buscar nodes múltiplos:", err);
        }
    }

    if (msg.type === "toggle-hidden") {
        showHiddenElements = msg.value;
        if (analyzedFrames.length) analyzeFrames(analyzedFrames);
    }

    setTimeout(() => (selectingFromUI = false), 50);
};

/* ---------- INIT ---------- */
figma.ui.postMessage({ type: "empty" });
console.log("Plugin iniciado ✅");