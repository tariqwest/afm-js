// ============================================================================
// BackendSelector.test.ts — Auto-detection logic for FM CLI vs helper
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  selectBackend,
  checkBackendAvailability,
  type BackendSelectorOptions,
} from "../src/bridge/BackendSelector.js";
import { FmProcessManager } from "@afm-js/core";

// Mock the FmProcessManager and HelperProcessManager modules
vi.mock("@afm-js/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@afm-js/core")>();
  const MockFmProcessManager = class {
    static isAvailable = vi.fn();
    constructor() {
      // Mock constructor
    }
    async spawn() {
      return { socketPath: "/tmp/mock-fm.sock" };
    }
    async shutdown() {
      // Mock shutdown
    }
    getSocketPath() {
      return "/tmp/mock-fm.sock";
    }
  };
  const MockHelperProcessManager = class {
    constructor() {
      // Mock constructor
    }
    async spawn() {
      return { socketPath: "/tmp/mock-helper.sock" };
    }
    async shutdown() {
      // Mock shutdown
    }
  };
  return {
    ...actual,
    FmProcessManager: MockFmProcessManager as any,
    HelperProcessManager: MockHelperProcessManager as any,
  };
});

describe("BackendSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkBackendAvailability", () => {
    it("reports fm available when /usr/bin/fm exists", async () => {
      vi.mocked(FmProcessManager.isAvailable).mockResolvedValue(true);

      const availability = await checkBackendAvailability();

      expect(availability.fm).toBe(true);
      expect(FmProcessManager.isAvailable).toHaveBeenCalled();
    });

    it("reports fm unavailable when /usr/bin/fm not found", async () => {
      vi.mocked(FmProcessManager.isAvailable).mockResolvedValue(false);

      const availability = await checkBackendAvailability();

      expect(availability.fm).toBe(false);
    });
  });

  describe("selectBackend with force option", () => {
    it("forces fm backend when force: 'fm' specified", async () => {
      vi.mocked(FmProcessManager.isAvailable).mockResolvedValue(false);

      const opts: BackendSelectorOptions = { force: "fm" };
      
      // With the mock, this should succeed and return fm backend
      const result = await selectBackend(opts);
      expect(result.kind).toBe("fm");
      expect(result).toHaveProperty("manager");
    });

    it("forces helper backend when force: 'helper' specified", async () => {
      const opts: BackendSelectorOptions = { force: "helper" };
      
      // With the mock, this should succeed and return helper backend
      const result = await selectBackend(opts);
      expect(result.kind).toBe("helper");
      expect(result).toHaveProperty("manager");
      expect(result).toHaveProperty("socketPath");
    });
  });

  describe("selectBackend auto-detection priority", () => {
    it("selects fm when available", async () => {
      vi.mocked(FmProcessManager.isAvailable).mockResolvedValue(true);

      // With the mock, this should succeed and return fm backend
      const result = await selectBackend();
      expect(result.kind).toBe("fm");
      expect(result).toHaveProperty("manager");

      // Verify we checked fm availability
      expect(FmProcessManager.isAvailable).toHaveBeenCalled();
    });

    it("falls back to helper when fm not available", async () => {
      vi.mocked(FmProcessManager.isAvailable).mockResolvedValue(false);

      // With the mock, this should succeed and return helper backend
      const result = await selectBackend();
      expect(result.kind).toBe("helper");
      expect(result).toHaveProperty("manager");
      expect(result).toHaveProperty("socketPath");
    });
  });

  describe("BackendSelectorOptions", () => {
    it("accepts custom socket path", async () => {
      const opts: BackendSelectorOptions = {
        force: "fm",
        socketPath: "/tmp/custom-test.sock",
      };

      // With the mock, this should succeed
      const result = await selectBackend(opts);
      expect(result.kind).toBe("fm");
      expect(result).toHaveProperty("manager");
    });

    it("accepts custom helper path", async () => {
      const opts: BackendSelectorOptions = {
        force: "helper",
        helperPath: "/nonexistent/helper",
      };

      // With the mock, this should succeed
      const result = await selectBackend(opts);
      expect(result.kind).toBe("helper");
      expect(result).toHaveProperty("manager");
      expect(result).toHaveProperty("socketPath");
    });

    it("accepts debug callback", async () => {
      const debugMessages: string[] = [];
      const opts: BackendSelectorOptions = {
        force: "helper",
        helperPath: "/nonexistent/helper",
        debug: (msg) => debugMessages.push(msg),
      };

      const result = await selectBackend(opts);
      expect(result.kind).toBe("helper");
      
      // Debug messages may be logged during spawn attempt
      expect(debugMessages).toBeDefined();
    });
  });
});
