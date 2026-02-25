"use client";
import React, { useState, useRef } from "react";
import { FileUpload } from "@/components/ui/file-upload";
import { ArrowUpIcon, PauseIcon, PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

interface UploadProgress {
  progress: number;
  speed: number;
  uploadedChunks: number;
  totalChunks: number;
  uploadedBytes: number;
  totalBytes: number;
}

export default function Home() {
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
  const CONCURRENCY = 5;
  const STORAGE_KEY = "multipart-upload-session";

  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    progress: 0,
    speed: 0,
    uploadedChunks: 0,
    totalChunks: 0,
    uploadedBytes: 0,
    totalBytes: 0
  });

  const startTimeRef = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);
  const lastBytesRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isPausedRef = useRef<boolean>(false);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  async function uploadFile(file: File) {
    let uploadId: string;
    let key: string;

    const savedSession = localStorage.getItem(STORAGE_KEY);

    if (savedSession) {
      const session = JSON.parse(savedSession);

      if (session.fileName === file.name && session.fileSize === file.size) {
        uploadId = session.uploadId;
        key = session.key;
        console.log("Resuming upload...");
      } else {
        localStorage.removeItem(STORAGE_KEY);
        return startNewUpload(file);
      }
    } else {
      return startNewUpload(file);
    }

    return resumeUpload(file, uploadId!, key!);
  }

  async function startNewUpload(file: File) {
    const startRes = await fetch("http://localhost:5000/uploads/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type
      })
    });

    const { uploadId, key } = await startRes.json();

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        uploadId,
        key,
        fileName: file.name,
        fileSize: file.size
      })
    );

    return resumeUpload(file, uploadId, key);
  }

  async function resumeUpload(
    file: File,
    uploadId: string,
    key: string
  ) {
    // Create new abort controller for this upload session
    abortControllerRef.current = new AbortController();
    isPausedRef.current = false;

    const partsRes = await fetch(
      `http://localhost:5000/uploads/parts?key=${key}&uploadId=${uploadId}`
    );
    const { parts } = await partsRes.json();

    // Create a map of all parts
    const partsMap = new Map<number, { PartNumber: number; ETag: string }>();

    let uploadedBytes = 0;
    for (const part of parts || []) {
      partsMap.set(part.PartNumber, part);
      const partSize = Math.min(CHUNK_SIZE, file.size - (part.PartNumber - 1) * CHUNK_SIZE);
      uploadedBytes += partSize;
    }

    const totalParts = Math.ceil(file.size / CHUNK_SIZE);

    // Initialize progress
    setUploadProgress({
      progress: Math.round((uploadedBytes / file.size) * 100),
      speed: 0,
      uploadedChunks: partsMap.size,
      totalChunks: totalParts,
      uploadedBytes: uploadedBytes,
      totalBytes: file.size
    });

    // Start timing
    startTimeRef.current = Date.now();
    lastUpdateRef.current = Date.now();
    lastBytesRef.current = uploadedBytes;

    const tasks: (() => Promise<void>)[] = [];

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      if (partsMap.has(partNumber)) {
        continue;
      }

      const start = (partNumber - 1) * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const task = async () => {
        // Check if paused before starting this chunk
        if (isPausedRef.current) {
          throw new Error('PAUSED');
        }

        const maxRetries = 3;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Check pause state before each attempt
            if (isPausedRef.current) {
              throw new Error('PAUSED');
            }

            const res = await fetch("http://localhost:5000/uploads/part-url", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key, uploadId, partNumber }),
              signal: abortControllerRef.current?.signal
            });

            if (!res.ok) throw new Error(`Failed to get upload URL: ${res.status}`);

            const { url } = await res.json();

            // Check pause state before upload
            if (isPausedRef.current) {
              throw new Error('PAUSED');
            }

            const uploadRes = await fetch(url, {
              method: "PUT",
              body: chunk,
              signal: abortControllerRef.current?.signal
            });

            if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);

            const etag = uploadRes.headers.get("ETag");
            if (!etag) throw new Error("No ETag returned");

            partsMap.set(partNumber, {
              PartNumber: partNumber,
              ETag: etag
            });

            uploadedBytes += chunk.size;

            // Calculate speed
            const now = Date.now();
            const timeDiff = (now - lastUpdateRef.current) / 1000;

            if (timeDiff > 0.3) {
              const bytesDiff = uploadedBytes - lastBytesRef.current;
              const speed = bytesDiff / timeDiff;

              setUploadProgress({
                progress: Math.round((uploadedBytes / file.size) * 100),
                speed: speed,
                uploadedChunks: partsMap.size,
                totalChunks: totalParts,
                uploadedBytes: uploadedBytes,
                totalBytes: file.size
              });

              lastUpdateRef.current = now;
              lastBytesRef.current = uploadedBytes;
            }

            return;
          } catch (error) {
            const err = error as Error;

            // Don't retry if paused or aborted
            if (err.message === 'PAUSED' || err.name === 'AbortError') {
              throw error;
            }

            lastError = err;
            if (attempt < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
          }
        }

        throw new Error(`Part ${partNumber} failed: ${lastError?.message}`);
      };

      tasks.push(task);
    }

    try {
      // Process with concurrency
      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        // Check if paused before each batch
        if (isPausedRef.current) {
          console.log('Upload paused');
          return { paused: true };
        }

        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(fn => fn()));
      }

      // Complete upload
      const allParts = Array.from(partsMap.values()).sort((a, b) => a.PartNumber - b.PartNumber);

      await fetch("http://localhost:5000/uploads/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          uploadId,
          parts: allParts
        })
      });

      localStorage.removeItem(STORAGE_KEY);

      setUploadProgress({
        progress: 100,
        speed: 0,
        uploadedChunks: totalParts,
        totalChunks: totalParts,
        uploadedBytes: file.size,
        totalBytes: file.size
      });

      console.log("Upload finished");
      return { key, completed: true };
    } catch (error) {
      const err = error as Error;
      if (err.message === 'PAUSED' || err.name === 'AbortError') {
        console.log('Upload paused by user');
        return { paused: true };
      }
      throw error;
    }
  }

  const handlePause = () => {
    if (abortControllerRef.current) {
      isPausedRef.current = true;
      abortControllerRef.current.abort();
      setIsPaused(true);
      setUploadProgress(prev => ({ ...prev, speed: 0 }));
      console.log('Pausing upload...');
    }
  };

  const handleResume = async () => {
    if (files.length === 0) return;

    setIsPaused(false);
    console.log('Resuming upload...');

    const file = files[0];

    try {
      const result = await uploadFile(file);

      if (result && 'completed' in result && result.completed) {
        alert('Upload complete!');
        setIsUploading(false);
      }
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Upload failed: ' + (error as Error).message);
      setIsUploading(false);
      setIsPaused(false);
    }
  };

  const handleStart = async () => {
    if (files.length === 0) return;

    const file = files[0];
    setIsUploading(true);
    setIsPaused(false);

    try {
      const result = await uploadFile(file);

      if (result && 'completed' in result && result.completed) {
        alert('Upload complete!');
      }
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Upload failed: ' + (error as Error).message);
    } finally {
      if (!isPausedRef.current) {
        setIsUploading(false);
      }
    }
  };

  const handleFileUpload = (files: File[]) => {
    setFiles(files);
    console.log(files);
  };

  // Calculate how many chunks to show as completed
  const completedChunks = Math.floor((uploadProgress.progress / 100) * 100);

  return (
    <div className="flex min-h-screen items-center justify-center font-sans bg-gray-100">
      <div>
        <div className="max-w-5xl mx-auto mb-10">
          <h1 className="text-zinc-900 text-center bg-clip-text text-5xl font-semibold">
            Make Every Chunk Flow Seamlessly
          </h1>
          <p className="text-center mx-auto max-w-3xl leading-6 mt-6 text-zinc-700">
            Upload large files in parallel chunks, resume instantly on failure, and trigger distributed transcoding pipelines powered by event-driven architecture.
          </p>
        </div>

        <div className="w-full px-3 max-w-4xl mx-auto lg:min-h-60 border border-dashed bg-white dark:bg-black border-neutral-200 dark:border-neutral-800 rounded-lg">
          <FileUpload disable={isUploading} onChange={handleFileUpload} />

          {/* Progress visualization */}
          <div className="flex max-w-2xl gap-0.5 mx-auto">
            {Array.from({ length: 100 }).map((_, idx) => (
              <div
                key={idx}
                className={`w-1.5 h-10 rounded-[2px] transition-colors duration-300 ${idx < completedChunks ? 'bg-[#12d191]' : 'bg-[#b8c0bd]'
                  }`}
              />
            ))}
          </div>

          {/* Stats display */}
          {isUploading && (
            <div className="max-w-2xl mx-auto mt-4 p-4 bg-gray-50 rounded-lg">
              <div className="grid grid-cols-3 gap-4 text-center text-sm">
                <div>
                  <div className="text-gray-600 mb-1">Progress</div>
                  <div className="font-semibold text-lg">{uploadProgress.progress}%</div>
                </div>
                <div>
                  <div className="text-gray-600 mb-1">Speed</div>
                  <div className="font-semibold text-lg">
                    {isPaused ? 'Paused' : `${formatBytes(uploadProgress.speed)}/s`}
                  </div>
                </div>
                <div>
                  <div className="text-gray-600 mb-1">Chunks</div>
                  <div className="font-semibold text-lg">
                    {uploadProgress.uploadedChunks} / {uploadProgress.totalChunks}
                  </div>
                </div>
              </div>
            </div>
          )}

          <hr className="my-4" />

          <div className="p-3 pt-0 flex justify-end gap-2 w-full">
            {isUploading && !isPaused && (
              <Button
                onClick={handlePause}
                variant="outline"
                className="cursor-pointer   bg-zinc-900 text-white hover:bg-zinc-800  hover:text-white/90"
                size="icon"
                aria-label="Pause"
              >
                <PauseIcon />
              </Button>
            )}

            {isUploading && isPaused && (
              <Button
                onClick={handleResume}
                variant="outline"
                className="cursor-pointer  bg-zinc-900 text-white hover:bg-zinc-800  hover:text-white/90"
                size="icon"
                aria-label="Resume"
              >
                <PlayIcon />
              </Button>
            )}

            

            {!isUploading && (
              <Button
                onClick={handleStart}
                disabled={files.length === 0}
                variant="outline"
                className="cursor-pointer bg-zinc-900 text-white hover:bg-zinc-800 hover:text-white/80 disabled:opacity-50 disabled:cursor-not-allowed"
                size="icon"
                aria-label="Start Upload"
              >
                <ArrowUpIcon />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}