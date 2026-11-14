"use client";

import { useRef, useState } from "react";

type Backend = "typescript" | "go";

interface ProcessingResult {
  duration: number;
  fileName: string;
  fileSize: number;
  blob: Blob;
}

export  function ExcelUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [backend, setBackend] = useState<Backend>("typescript");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [error, setError] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);

  function selectFile(selected: File | undefined) {
    if (!selected) return;

    setResult(null);
    setError("");

    if (!selected.name.toLowerCase().endsWith(".xlsx")) {
      setError("Please select an XLSX file.");
      return;
    }

    if (selected.size > 50 * 1024 * 1024) {
      setError("Maximum file size is 50 MB.");
      return;
    }

    setFile(selected);
  }

  async function processFile() {
    if (!file || loading) return;

    setLoading(true);
    setError("");
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    const start = performance.now();

    try {
      const response = await fetch(`/api/${backend}/process`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error((await response.text()) || "Processing failed");
      }

      const blob = await response.blob();
      const duration = performance.now() - start;

      setResult({
        duration,
        fileName: "processed.xlsx",
        fileSize: blob.size,
        blob,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function downloadFile() {
    if (!result) return;

    const url = URL.createObjectURL(result.blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = result.fileName;
    link.click();

    URL.revokeObjectURL(url);
  }

  function reset() {
    setFile(null);
    setResult(null);
    setError("");

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  const formatSize = (bytes: number) =>
    `${(bytes / 1024 / 1024).toFixed(2)} MB`;

  return (
    <main className="min-h-screen bg-slate-950 text-white px-5 py-16">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="text-sm text-blue-400 font-semibold mb-3">
            PERFORMANCE EXPERIMENT
          </div>

          <h1 className="text-4xl font-bold mb-4">Excel Benchmark Lab</h1>

          <p className="text-slate-400">
            Compare TypeScript and Go performance using heavy Excel processing.
          </p>
        </div>

        {/* Main card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {/* Backend selection */}
          <h2 className="font-semibold mb-4">Select implementation</h2>

          <div className="grid grid-cols-2 gap-4 mb-8">
            <button
              onClick={() => setBackend("typescript")}
              disabled={loading}
              className={`p-4 rounded-xl border text-left transition ${
                backend === "typescript"
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-slate-700 bg-slate-800"
              }`}
            >
              <div className="text-blue-400 font-bold">TypeScript</div>
              <div className="text-xs text-slate-400 mt-1">
                Next.js Route Handler
              </div>
            </button>

            <button
              onClick={() => setBackend("go")}
              disabled={loading}
              className={`p-4 rounded-xl border text-left transition ${
                backend === "go"
                  ? "border-green-500 bg-green-500/10"
                  : "border-slate-700 bg-slate-800"
              }`}
            >
              <div className="text-green-400 font-bold">Go</div>
              <div className="text-xs text-slate-400 mt-1">
                Go Route Handler
              </div>
            </button>
          </div>

          {/* File upload */}
          <h2 className="font-semibold mb-4">Upload Excel workbook</h2>

          <div
            onClick={() => inputRef.current?.click()}
            className="border-2 border-dashed border-slate-700 hover:border-blue-500 rounded-xl p-10 text-center cursor-pointer transition"
          >
            <div className="text-4xl mb-3">📊</div>

            <p className="font-medium">Click to select your Excel file</p>

            <p className="text-sm text-slate-500 mt-2">
              XLSX format · Maximum 50 MB
            </p>

            <input
              ref={inputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => selectFile(e.target.files?.[0])}
            />
          </div>

          {/* Selected file */}
          {file && (
            <div className="mt-5 p-4 bg-slate-800 rounded-xl flex items-center justify-between">
              <div className="min-w-0">
                <p className="font-medium truncate">📄 {file.name}</p>
                <p className="text-sm text-slate-400">
                  {formatSize(file.size)}
                </p>
              </div>

              <button
                onClick={reset}
                disabled={loading}
                className="text-red-400 text-sm ml-3"
              >
                Remove
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-5 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Process button */}
          <button
            onClick={processFile}
            disabled={!file || loading}
            className="w-full mt-6 p-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400 font-semibold transition"
          >
            {loading
              ? "Processing Excel..."
              : `Process with ${backend === "go" ? "Go" : "TypeScript"}`}
          </button>

          {/* Result */}
          {result && (
            <div className="mt-6 border border-green-500/30 bg-green-500/5 rounded-xl p-5">
              <h3 className="text-green-400 font-bold mb-4">
                ✓ Processing completed
              </h3>

              <div className="grid grid-cols-2 gap-4 mb-5">
                <div>
                  <p className="text-xs text-slate-400">Total duration</p>
                  <p className="text-2xl font-bold">
                    {result.duration.toFixed(2)} ms
                  </p>
                </div>

                <div>
                  <p className="text-xs text-slate-400">Output size</p>
                  <p className="text-2xl font-bold">
                    {formatSize(result.fileSize)}
                  </p>
                </div>
              </div>

              <button
                onClick={downloadFile}
                className="w-full bg-green-600 hover:bg-green-500 p-3 rounded-lg font-semibold"
              >
                Download processed Excel
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-slate-500 mt-6">
          Experimental benchmark · TypeScript vs Go
        </p>
      </div>
    </main>
  );
}
