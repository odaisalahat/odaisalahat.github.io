import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import PDFParser from "pdf2json";
import Drawing from "dxf-writer";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// Ensure uploads directory exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// PDF to DXF Conversion Logic
async function convertPdfToDxf(pdfPath: string, dxfPath: string, userScale: number = 1.0): Promise<void> {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();

    pdfParser.on("pdfParser_dataError", (errData: any) => {
      console.error("PDF Parser Error:", errData);
      reject(errData.parserError || errData);
    });

    pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
      try {
        console.log("PDF Data Ready. Pages:", pdfData.Pages?.length);
        const drawing = new Drawing();
        drawing.setUnits('Millimeters');

        const BASE_SCALE = 25.4 / 40.0; 
        const SCALE = BASE_SCALE * userScale;

        const colorMap: { [key: number]: number } = {
          0: Drawing.ACI.WHITE, // Substitute for Black
          1: Drawing.ACI.RED,
          2: Drawing.ACI.YELLOW,
          3: Drawing.ACI.GREEN,
          4: Drawing.ACI.CYAN,
          5: Drawing.ACI.BLUE,
          6: Drawing.ACI.MAGENTA,
          7: Drawing.ACI.WHITE,
        };

        if (!pdfData.Pages || pdfData.Pages.length === 0) {
          throw new Error("No pages found in PDF");
        }

        pdfData.Pages.forEach((page: any, pageIndex: number) => {
          const layerName = `LAYER_PAGE_${pageIndex + 1}`;
          drawing.addLayer(layerName, Drawing.ACI.WHITE, 'CONTINUOUS');
          drawing.setActiveLayer(layerName);

          // Process Horizontal Lines
          if (page.HLines && page.HLines.length > 0) {
            page.HLines.forEach((line: any) => {
              drawing.drawLine(
                line.x * SCALE, 
                -line.y * SCALE, 
                (line.x + line.w) * SCALE, 
                -line.y * SCALE
              );
            });
          }

          // Process Vertical Lines
          if (page.VLines && page.VLines.length > 0) {
            page.VLines.forEach((line: any) => {
              drawing.drawLine(
                line.x * SCALE, 
                -line.y * SCALE, 
                line.x * SCALE, 
                -(line.y + line.l) * SCALE
              );
            });
          }

          // Process Fills
          if (page.Fills && page.Fills.length > 0) {
            page.Fills.forEach((fill: any) => {
              const x1 = fill.x * SCALE;
              const y1 = -fill.y * SCALE;
              const x2 = (fill.x + fill.w) * SCALE;
              const y2 = -(fill.y + fill.h) * SCALE;
              drawing.drawRect(x1, y1, x2, y2);
            });
          }

          // Process Rects
          if (page.Rects && page.Rects.length > 0) {
            page.Rects.forEach((rect: any) => {
              const x1 = rect.x * SCALE;
              const y1 = -rect.y * SCALE;
              const x2 = (rect.x + rect.w) * SCALE;
              const y2 = -(rect.y + rect.h) * SCALE;
              drawing.drawRect(x1, y1, x2, y2);
            });
          }

          // Process Texts
          if (page.Texts && page.Texts.length > 0) {
            page.Texts.forEach((textObj: any) => {
              const x = textObj.x * SCALE;
              const y = -textObj.y * SCALE;
              if (textObj.R && textObj.R[0]) {
                let text = "";
                try {
                  // Check if text is already decoded or doesn't need decoding
                  if (textObj.R[0].T.indexOf('%') === -1) {
                    text = textObj.R[0].T;
                  } else {
                    text = decodeURIComponent(textObj.R[0].T);
                  }
                } catch (e) {
                  // Fallback if decodeURIComponent fails (e.g. malformed URI or already contains %)
                  text = textObj.R[0].T;
                }
                const fontSize = (textObj.R[0].TS[1] || 12) * (SCALE * 0.8); 
                const rotation = textObj.R[0].RA || 0;
                drawing.drawText(x, y, fontSize, rotation, text);
              }
            });
          }
        });

        const dxfString = drawing.toDxfString();
        console.log("Generated DXF String Length:", dxfString.length);
        fs.writeFileSync(dxfPath, dxfString);
        resolve();
      } catch (error) {
        console.error("Conversion Logic Error:", error);
        reject(error);
      }
    });

    // Important: loadPDF triggers the events. 
    // In newer versions of pdf2json, it might return a promise or just use events.
    pdfParser.loadPDF(pdfPath);
  });
}

// API Routes
app.post("/api/convert", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const inputPath = req.file.path;
  const outputFilename = `${req.file.filename}.dxf`;
  const outputPath = path.join("uploads", outputFilename);
  const scale = parseFloat(req.body.scale || "1.0");

  try {
    await convertPdfToDxf(inputPath, outputPath, scale);
    res.json({ 
      success: true, 
      downloadUrl: `/api/download/${outputFilename}`,
      originalName: req.file.originalname.replace(".pdf", ".dxf")
    });
  } catch (error: any) {
    console.error("Conversion error:", error);
    res.status(500).json({ error: "Failed to convert PDF to DXF", details: error.message });
  } finally {
    // We keep the files for download, but maybe cleanup later
  }
});

app.get("/api/download/:filename", (req, res) => {
  const filePath = path.join("uploads", req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send("File not found");
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
