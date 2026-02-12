"use strict";

// Exibe a UI do plugin
figma.showUI(__html__, { width: 360, height: 422 });

// Variáveis de estado
let showHiddenElements = false;
let currentTab: "colors" | "typography" = "colors";
let ignoringSelectionChange = false;
let rootFrameId: string | null = null;
let initialSelectionIds: string[] | null = null;
let nodesWithAppliedToken = new Set<string>();



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

// Prefixos válidos de tokens de cor
const VALID_TOKEN_PREFIXES = [
    "Base Color/",
    "Contextual Color/",
    "Base/",
    "Surface Colors/",
    "Content Colors/",
    "Brand Colors/"
];

// Função para aplicar um token de tipografia em múltiplos TextNodes
async function applyTypographyToken(nodeIds: string[], styleId: string) {
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && node.type === "TEXT" && node.characters.length > 0) {
      const textNode = node as TextNode;
      await textNode.setRangeTextStyleIdAsync(0, textNode.characters.length, styleId);
    }
  }
}


// Verifica se um paint tem token válido
async function hasValidColorToken(node: SceneNode, paint: Paint): Promise<boolean> {
    // 1️⃣ Variable
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
                // Style não encontrado
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
                // Style não encontrado
            }
        }
    }

    return false;
}

// Verifica se um nó de texto tem token de tipografia válido
async function hasValidTextToken(node: TextNode): Promise<boolean> {
    if (node.textStyleId && typeof node.textStyleId === "string" && node.textStyleId !== "") {
        return true;
    }
    return false;
}

// Função helper para fazer yield e permitir UI updates
function yieldToUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// Calcula a "distância" entre dois estilos de texto
function calculateTextStyleDistance(
    source: { fontFamily: string; fontSize?: number; fontWeight?: any },
    target: { fontFamily?: string; fontSize?: number; fontWeight?: any }
): number {
    let distance = 0;
    
    // Família diferente = +100
    if (source.fontFamily !== target.fontFamily) {
        distance += 100;
    }
    
    // Diferença de tamanho
    if (source.fontSize && target.fontSize) {
        distance += Math.abs(source.fontSize - target.fontSize);
    }
    
    // Diferença de peso
    const sourceWeight = typeof source.fontWeight === "number" ? source.fontWeight : 400;
    const targetWeight = typeof target.fontWeight === "number" ? target.fontWeight : 400;
    distance += Math.abs(sourceWeight - targetWeight) / 100;
    
    return distance;
}

// Coleta todos os estilos locais de cores disponíveis
async function collectAllLocalColorStyles(): Promise<{ name: string; hex: string; styleId: string }[]> {
    const localStyles = await figma.getLocalPaintStylesAsync();
    const validPrefixTokens: { name: string; hex: string; styleId: string }[] = [];
    const fallbackTokens: { name: string; hex: string; styleId: string }[] = [];
    
    for (const style of localStyles) {
        // Verifica se é um estilo SOLID
        if (style.paints && style.paints.length > 0) {
            const firstPaint = style.paints[0];
            if (firstPaint.type === "SOLID") {
                const hex = rgbToHex(firstPaint.color);
                const token = { name: style.name, hex, styleId: style.id };

                if (VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                    validPrefixTokens.push(token);
                }

                fallbackTokens.push(token);
            }
        }
    }
    
    return validPrefixTokens.length > 0 ? validPrefixTokens : fallbackTokens;
}

// Percorre nó recursivamente coletando tokens de COR
async function walkForColorTokens(node: SceneNode, tokenSet: Map<string, { name: string; hex: string; styleId?: string }>): Promise<void> {
    if (!showHiddenElements && !node.visible) return;

    // Processa fills
    if ("fills" in node && Array.isArray(node.fills)) {
        for (const p of node.fills) {
            if (!p || p.visible === false || p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") continue;

            if (p.type === "SOLID" && "fillStyleId" in node) {
                const styleId = node.fillStyleId;
                if (typeof styleId === "string" && styleId !== "") {
                    try {
                        const style = await figma.getStyleByIdAsync(styleId);
                        if (style && VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                            const hex = rgbToHex(p.color);
                            const key = `${style.name}_${hex}`;
                            tokenSet.set(key, { name: style.name, hex, styleId });
                        }
                    } catch (e) {
                        // Style não encontrado
                    }
                }
            }
        }
    }

    // Processa strokes
    if ("strokes" in node && Array.isArray(node.strokes)) {
        for (const p of node.strokes) {
            if (!p || p.visible === false || p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") continue;

            if (p.type === "SOLID" && "strokeStyleId" in node) {
                const styleId = node.strokeStyleId;
                if (typeof styleId === "string" && styleId !== "") {
                    try {
                        const style = await figma.getStyleByIdAsync(styleId);
                        if (style && VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                            const hex = rgbToHex(p.color);
                            const key = `${style.name}_${hex}`;
                            tokenSet.set(key, { name: style.name, hex, styleId });
                        }
                    } catch (e) {
                        // Style não encontrado
                    }
                }
            }
        }
    }

    // Percorre filhos recursivamente
    if ("children" in node) {
        for (const c of node.children) {
            if (isSceneNode(c)) await walkForColorTokens(c, tokenSet);
        }
    }
}

// Percorre nó recursivamente coletando tokens de TIPOGRAFIA
async function walkForTextTokens(node: SceneNode, tokenSet: Map<string, { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }>): Promise<void> {
    if (!showHiddenElements && !node.visible) return;

    // Processa texto
    if (node.type === "TEXT") {
        const textNode = node as TextNode;
        if (textNode.textStyleId && typeof textNode.textStyleId === "string" && textNode.textStyleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(textNode.textStyleId);
                if (style && style.type === "TEXT") {
                    const key = style.id;
                    
                    // Extrai informações do estilo
                    const fontName = textNode.fontName !== figma.mixed ? textNode.fontName : { family: "Mixed", style: "Mixed" };
                    const fontSize = textNode.fontSize !== figma.mixed ? textNode.fontSize : undefined;
                    
                    tokenSet.set(key, { 
                        name: style.name, 
                        styleId: style.id,
                        fontFamily: fontName.family,
                        fontStyle: fontName.style,
                        fontSize: fontSize
                    });
                }
            } catch (e) {
                // Style não encontrado
            }
        }
    }

    // Percorre filhos recursivamente
    if ("children" in node) {
        for (const c of node.children) {
            if (isSceneNode(c)) await walkForTextTokens(c, tokenSet);
        }
    }
}

// Coleta tokens de cor aplicados - busca em TODA a página E estilos locais
async function collectAppliedColorTokens(
  frames: (FrameNode | ComponentNode | InstanceNode)[]
): Promise<{ name: string; hex: string; styleId?: string }[]> {

  const tokenSet = new Map<string, { name: string; hex: string; styleId?: string }>();

  // 🔥 1️⃣ PRIMEIRO: pega TODOS os estilos locais
  const localStyles = await figma.getLocalPaintStylesAsync();

  for (const style of localStyles) {
    if (!style.paints || style.paints.length === 0) continue;

    const firstPaint = style.paints[0];
    if (firstPaint.type !== "SOLID") continue;

    const hex = rgbToHex(firstPaint.color);

    tokenSet.set(style.id, {
      name: style.name,
      hex,
      styleId: style.id
    });
  }

  // 🔥 2️⃣ Depois busca os aplicados no frame (prioridade)
  async function walk(node: SceneNode) {

    if (!showHiddenElements && !node.visible) return;

    // FILLS
    if ("fills" in node && Array.isArray(node.fills)) {
      for (const paint of node.fills) {

        if (!paint || paint.type !== "SOLID") continue;

        if (
          "fillStyleId" in node &&
          typeof node.fillStyleId === "string" &&
          node.fillStyleId !== ""
        ) {
          const style = await figma.getStyleByIdAsync(node.fillStyleId);

          if (style) {
            tokenSet.set(style.id, {
              name: style.name,
              hex: rgbToHex(paint.color),
              styleId: style.id
            });
          }
        }
      }
    }

    // STROKES
    if ("strokes" in node && Array.isArray(node.strokes)) {
      for (const paint of node.strokes) {

        if (!paint || paint.type !== "SOLID") continue;

        if (
          "strokeStyleId" in node &&
          typeof node.strokeStyleId === "string" &&
          node.strokeStyleId !== ""
        ) {
          const style = await figma.getStyleByIdAsync(node.strokeStyleId);

          if (style) {
            tokenSet.set(style.id, {
              name: style.name,
              hex: rgbToHex(paint.color),
              styleId: style.id
            });
          }
        }
      }
    }

    if ("children" in node) {
      for (const child of node.children) {
        if (isSceneNode(child)) {
          await walk(child);
        }
      }
    }
  }

  for (const frame of frames) {
    await walk(frame);
  }

  return Array.from(tokenSet.values()).slice(0, 20);
}



// Coleta tokens de texto aplicados - com ordenação por similaridade
async function collectAppliedTextTokens(
    frames: (FrameNode | ComponentNode | InstanceNode)[],
    currentStyle?: { fontFamily: string; fontSize?: number; fontWeight?: any }
): Promise<{ name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }[]> {
    const tokenSet = new Map<string, { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }>();

    // 🔥 Busca TODOS os estilos de texto locais disponíveis primeiro
    const localTextStyles = await figma.getLocalTextStylesAsync();
    
    for (const style of localTextStyles) {
        try {
            const key = `${style.name}_${style.id}`;
            
            // Tenta carregar a fonte para obter detalhes
            let fontFamily = undefined;
            let fontStyle = undefined;
            let fontSize = undefined;
            
            if (style.fontName && typeof style.fontName === 'object' && 'family' in style.fontName) {
                fontFamily = style.fontName.family;
                fontStyle = style.fontName.style;
            }
            
            if (style.fontSize && typeof style.fontSize === 'number') {
                fontSize = style.fontSize;
            }
            
            tokenSet.set(key, {
                name: style.name,
                styleId: style.id,
                fontFamily,
                fontStyle,
                fontSize
            });
        } catch (e) {
            // Ignora erros ao carregar fonte
        }
    }

    // Busca nos frames selecionados (sobrescreve se encontrar)
    for (const frame of frames) {
        await walkForTextTokens(frame, tokenSet);
    }

    let tokens = Array.from(tokenSet.values());
    
    // Se temos um estilo atual, ordena por similaridade
    if (currentStyle) {
        tokens = tokens.sort((a, b) => {
            const distA = calculateTextStyleDistance(currentStyle, a);
            const distB = calculateTextStyleDistance(currentStyle, b);
            return distA - distB;
        });
    }
    
    // Limita a 10 tokens
    return tokens.slice(0, 6);
}

/* ---------- ANALYZE FUNCTIONS ---------- */

// Analisa cores sem tokens
// Analisa cores sem tokens
async function analyzeColors(frames: (FrameNode | ComponentNode | InstanceNode)[]) {
    // Map: chave = label + tipo (fill/stroke)
    const map = new Map<
        string,
        { nodeId: string; node: SceneNode; paint: Paint; isStroke: boolean; label: string; name: string }[]
    >();

    async function processPaint(node: SceneNode, paint: Paint, isStroke: boolean): Promise<void> {
        if (!paint || paint.visible === false) return;
        if (paint.type === "IMAGE" || paint.type === "VIDEO" || paint.type === "PATTERN") return;

        const hasToken = await hasValidColorToken(node, paint);
        if (hasToken) return;

        let label: string;
        let name: string;

        if (paint.type === "SOLID") {
            label = rgbToHex(paint.color); // hexadecimal
        } else if (isGradientPaint(paint)) {
            label = "Gradiente";
        } else {
            return;
        }

        // Recupera styleId apenas se o nó suportar
        let styleId: string | undefined;
        if ("fillStyleId" in node && !isStroke) {
            styleId = node.fillStyleId as string | undefined;
        } else if ("strokeStyleId" in node && isStroke) {
            styleId = node.strokeStyleId as string | undefined;
        }

        if (styleId) {
            try {
            const style = await figma.getStyleByIdAsync(styleId);
            name = style ? style.name : label;
        } catch (e) {
            name = label;
        }

        } else {
            name = label;
        }

        const key = `${label}_${isStroke ? "stroke" : "fill"}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, node, paint, isStroke, label, name });
    }


    // Caminha recursivamente pelos filhos
    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

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

        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    // Percorre todos os frames selecionados
    for (const frame of frames) {
        await walk(frame);
    }

    // Cria array final para enviar à UI
    const groups = Array.from(map.values()).map(nodePaints => ({
        label: nodePaints[0].label, // hexadecimal ou "Gradiente"
        nodePaints
    }));

    figma.ui.postMessage({ type: "result-colors", groups });
}



// Analisa tipografias sem tokens
async function analyzeTypography(frames: (FrameNode | ComponentNode | InstanceNode)[]) {
    const map = new Map<string, { nodeId: string; node: TextNode; style: CustomTextStyle }[]>();

    async function processTextNode(node: TextNode): Promise<void> {
        const hasToken = await hasValidTextToken(node);
        if (hasToken) return;

        const fontName = node.fontName !== figma.mixed ? node.fontName : { family: "Mixed", style: "Mixed" };
        const fontSize = node.fontSize !== figma.mixed ? node.fontSize : "Mixed";
        const fontWeight = node.fontWeight !== figma.mixed ? node.fontWeight : "Mixed";
        const lineHeight = node.lineHeight !== figma.mixed ? node.lineHeight : "AUTO";
        const letterSpacing = node.letterSpacing !== figma.mixed ? node.letterSpacing : "0";

        const style: CustomTextStyle = {
            fontFamily: fontName.family,
            fontStyle: fontName.style,
            fontSize: fontSize,
            fontWeight: fontWeight,
            lineHeight: lineHeight,
            letterSpacing: letterSpacing
        };

        const key = `${fontName.family}_${fontName.style}`;

        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, node, style });
    }

    let nodeCount = 0;

    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        if (node.type === "TEXT") {
            await processTextNode(node);
        }

        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    for (const frame of frames) {
        await walk(frame);
    }

    const groups = Array.from(map.values()).map(nodeStyles => {
        const first = nodeStyles[0].style;
        return { 
            style: first,
            nodeStyles,
            label: `${first.fontFamily} ${first.fontStyle}`
        };
    });

    figma.ui.postMessage({ type: "result-typography", groups });
}

/* ---------- TYPES ---------- */

interface CustomTextStyle {
    fontFamily: string;
    fontStyle: string;
    fontSize: any;
    fontWeight: any;
    lineHeight: any;
    letterSpacing: any;
}

/* ---------- EVENTS ---------- */

figma.on("selectionchange", () => {

    if (ignoringSelectionChange) {
        ignoringSelectionChange = false;
        return;
    }

    const validNodes = figma.currentPage.selection.filter(
        (n): n is FrameNode | ComponentNode | InstanceNode => 
            n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
    );

    if (validNodes.length > 0) {
        rootFrameId = validNodes[0].id;
    }



    if (validNodes.length === 0) {
        figma.ui.postMessage({ type: "empty", clearAll: true });
        return;
    }

    if (currentTab === "colors") {
        analyzeColors(validNodes);
    } else {
        analyzeTypography(validNodes);
    }
});

figma.ui.onmessage = async (msg) => {
    console.log("📩 mensagem recebida:", msg);

    if (msg.type === "enter-list-view") {
        // 🔒 Salva a seleção inicial se ainda não foi salva
        if (!initialSelectionIds) {
            initialSelectionIds = figma.currentPage.selection.map(n => n.id);
            console.log("📌 seleção inicial salva:", initialSelectionIds);
        }
        
        // 🔥 Garante que temos um rootFrameId salvo
        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode => 
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );
        
        if (validNodes.length > 0 && !rootFrameId) {
            rootFrameId = validNodes[0].id;
            console.log("📌 rootFrameId salvo:", rootFrameId);
        }
    }

    if (msg.type === "select-node") {
        try {
            ignoringSelectionChange = true;
            const node = await figma.getNodeByIdAsync(msg.nodeId);
            if (node && isSceneNode(node)) {
                figma.currentPage.selection = [node];
                figma.viewport.scrollAndZoomIntoView([node]);
            }
        } catch (err) {
            console.error("Erro ao buscar node:", err);
        }
    }

    if (msg.type === "select-multiple-nodes") {
    try {
        ignoringSelectionChange = true;

        const nodes = await Promise.all(
        msg.nodeIds.map((id: string) => figma.getNodeByIdAsync(id))
        );


        // Mantém apenas SceneNodes válidos
        const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));

        // Filtra TEXT nodes que têm texto e textStyleId válido
        const safeNodes = validNodes.filter(n => {
            if (n.type === "TEXT") {
                return n.characters.length > 0;  // evita texto vazio
            }
            return true;
        });

        if (safeNodes.length) {
            figma.currentPage.selection = safeNodes;
            figma.viewport.scrollAndZoomIntoView(safeNodes);
        }
    } catch (err) {
        console.error("Erro ao selecionar nodes:", err);
    }
}



    if (msg.type === "get-suggested-tokens") {
        try {
            let validNodes = figma.currentPage.selection.filter(
                (n): n is FrameNode | ComponentNode | InstanceNode => 
                    n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
            );

            if (validNodes.length === 0 && rootFrameId) {
                const rootNode = await figma.getNodeByIdAsync(rootFrameId);
                if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                    validNodes = [rootNode];
                }
            }
            
            if (validNodes.length > 0) {
                if (currentTab === "colors") {
                    const appliedTokens = await collectAppliedColorTokens(validNodes);
                    figma.ui.postMessage({ type: "result-suggested-tokens", tokens: appliedTokens });
                } else {
                    // Para tipografia, pega o estilo atual do nó selecionado
                    let currentStyle = undefined;
                    if (msg.nodeId) {
                        const node = await figma.getNodeByIdAsync(msg.nodeId);
                        if (node && node.type === "TEXT" && node.characters.length > 0) {
                            const fontName = node.fontName !== figma.mixed ? node.fontName : { family: "Inter", style: "Regular" };
                            const fontSize = node.fontSize !== figma.mixed ? node.fontSize : 14;
                            const fontWeight = node.fontWeight !== figma.mixed ? node.fontWeight : 400;
                            currentStyle = {
                                fontFamily: fontName.family,
                                fontSize,
                                fontWeight
                            };
                        }
                    }
                    const appliedTokens = await collectAppliedTextTokens(validNodes, currentStyle);
                    figma.ui.postMessage({ type: "result-suggested-text-tokens", tokens: appliedTokens });
                }
            } else {
                figma.ui.postMessage({ type: "result-suggested-tokens", tokens: [] });
            }
        } catch (err) {
            console.error("Erro ao buscar tokens sugeridos:", err);
            figma.ui.postMessage({ type: "result-suggested-tokens", tokens: [] });
        }
    }

    if (msg.type === "apply-token-multiple") {
  const styleId = msg.styleId;
  const nodeIds: string[] = msg.nodeIds || [];

  const style = await figma.getStyleByIdAsync(styleId);

  if (!style) {
    console.log("❌ Style não encontrado");
    return;
  }

  if (style.type !== "PAINT") {
    console.log("❌ Style não é PAINT, type atual:", style.type);
    return;
  }

  for (const nodeId of nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) continue;

    if ("fills" in node) {
      await node.setFillStyleIdAsync(styleId);
    } else if ("strokes" in node) {
      await node.setStrokeStyleIdAsync(styleId);
    } else {
      console.log("⚠️ Node não tem fills nem strokes:", node.type);
    }
  }

  figma.ui.postMessage({ type: "token-applied-success" });
}




    if (msg.type === "apply-token") {
        try {
            const styleId = msg.styleId;
            const isStroke = msg.isStroke;
            const isText = msg.isText || false;

            const nodeIds: string[] = msg.nodeIds || [msg.nodeId];
            const nodes = await Promise.all(nodeIds.map(id => figma.getNodeByIdAsync(id)));

            const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));

            await Promise.all(validNodes.map(async (node) => {
                if (isText && node.type === "TEXT") {
                    const style = await figma.getStyleByIdAsync(styleId);
                    if (style && style.type === "TEXT") {
                        await figma.loadFontAsync(style.fontName as FontName);
                        // Aplica o token individualmente em cada nó
                        await node.setTextStyleIdAsync(styleId);

                        // 🔹 marca node como token aplicado
                        nodesWithAppliedToken.add(node.id);
                    }
                } else if (isStroke && "setStrokeStyleIdAsync" in node) {
                    await node.setStrokeStyleIdAsync(styleId);
                    nodesWithAppliedToken.add(node.id);

                } else if (!isStroke && "setFillStyleIdAsync" in node) {
                    await node.setFillStyleIdAsync(styleId);
                    nodesWithAppliedToken.add(node.id);
                }

            }));

            // Reanalisa após aplicar
            const frames = figma.currentPage.selection.filter(
                (n): n is FrameNode | ComponentNode | InstanceNode =>
                    n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
            );

            if (frames.length > 0) {
                if (currentTab === "colors") {
                    await analyzeColors(frames);
                } else {
                    await analyzeTypography(frames);
                }
            }

            figma.ui.postMessage({ type: "token-applied-success" });
        } catch (err) {
            console.error("Erro ao aplicar token:", err);
            figma.ui.postMessage({ type: "token-applied-error" });
        }
    }

    if (msg.type === "apply-typography-token-multiple") {
        const styleId = msg.styleId;
        const nodeIds: string[] = msg.nodeIds || [];

        const style = await figma.getStyleByIdAsync(styleId);

        if (!style || style.type !== "TEXT") {
            console.log("❌ Style não é TEXT");
            return;
        }

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);

            if (node && node.type === "TEXT") {
            await figma.loadFontAsync(node.fontName as FontName);
            await node.setTextStyleIdAsync(styleId);
            }
        }

        figma.ui.postMessage({ type: "token-applied-success" });
        }








    if (msg.type === "toggle-hidden") {
        showHiddenElements = msg.value;
        
        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode => 
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );
        
        // 🔥 Se não há seleção atual mas temos um rootFrameId salvo, usa ele
        if (validNodes.length === 0 && rootFrameId) {
            const rootNode = await figma.getNodeByIdAsync(rootFrameId);
            if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                validNodes.push(rootNode);
            }
        }
        
        if (validNodes.length > 0) {
            if (currentTab === "colors") {
                await analyzeColors(validNodes);
            } else {
                await analyzeTypography(validNodes);
            }
        }
    }

    if (msg.type === "switch-tab") {
        currentTab = msg.tab;
        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode => 
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );
        
        if (validNodes.length === 0) {
            figma.ui.postMessage({ type: "empty", clearAll: true });
        } else {
            if (currentTab === "colors") {
                analyzeColors(validNodes);
            } else {
                analyzeTypography(validNodes);
            }
        }
    }

    if (msg.type === "back-to-list") {
        if (!initialSelectionIds || initialSelectionIds.length === 0) return;

        const nodes = (
            await Promise.all(initialSelectionIds.map(id => figma.getNodeByIdAsync(id)))
        )
            .filter((n): n is SceneNode => !!n && isSceneNode(n))
            // 🔹 remove nodes que receberam token
            .filter(n => !nodesWithAppliedToken.has(n.id));

        if (!nodes.length) return;

        ignoringSelectionChange = true;
        figma.currentPage.selection = nodes;
        figma.viewport.scrollAndZoomIntoView(nodes);

        // 🔄 libera para próxima navegação
        initialSelectionIds = null;
    }





};

/* ---------- INIT ---------- */
figma.ui.postMessage({ type: "empty", clearAll: true });
figma.ui.postMessage({ type: "init-tab", tab: currentTab });
console.log("Plugin iniciado ✅");