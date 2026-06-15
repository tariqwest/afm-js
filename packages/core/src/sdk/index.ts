// ============================================================================
// SDK module — High-level client for Apple Foundation Models
//
// Mirrors the ergonomics of python-apple-fm-sdk:
// - SystemLanguageModel: Check availability, get default model
// - LanguageModelSession: Stateful conversation
// - Transcript utilities: Process transcripts from Swift apps
// ============================================================================

// Legacy client (kept for backward compatibility)
export {
  AfmClient,
  type AfmClientOptions,
  type BackendType,
  type GenerateRequest,
  type GenerateResponse,
  type GenerationChunk,
  type AvailabilityStatus,
} from "./AfmClient.js";

// Pythonic SDK classes
export {
  SystemLanguageModel,
  LanguageModelSession,
  type LanguageModelSessionOptions,
  type ModelResponse,
  type ResponseChunk,
  type ModelBackendType,
  type AvailabilityReason,
} from "./LanguageModel.js";

// Transcript processing utilities
export {
  loadTranscript,
  parseTranscript,
  extractTextFromContents,
  analyzeTranscript,
  printTranscriptSummary,
  printTranscriptEntries,
  compareTranscripts,
  exportAnalysisToJsonl,
  type Transcript,
  type TranscriptEntry,
  type TranscriptContent,
  type ToolCall as TranscriptToolCall,
  type TranscriptAnalysis,
  type TranscriptComparison,
} from "./transcript.js";
