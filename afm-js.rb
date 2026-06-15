class AfmJs < Formula
  desc "Apple Foundation Models for Node.js — OpenAI-compatible HTTP server + CLI"
  homepage "https://github.com/tariqwest/afm-js"
  url "https://github.com/tariqwest/afm-js/releases/download/v0.0.3/afm-js-prebuilt-arm64-apple-darwin-0.0.3.tar.gz"
  sha256 "b5a2c96250612366ea272ffac6d9744aaf4b45aacd96aa7cfcb931ee3b558259"
  license "MIT"
  version "0.0.3"

  depends_on "node"
  depends_on :macos
  depends_on arch: :arm64

  resource "afm-fm-helper" do
    url "https://github.com/tariqwest/afm-js/releases/download/v0.0.3/afm-fm-helper-arm64-apple-darwin-0.0.3.tar.gz"
    sha256 "b5a2c96250612366ea272ffac6d9744aaf4b45aacd96aa7cfcb931ee3b558259"
  end

  def install
    # Install prebuilt afm-js package
    libexec.install Dir["dist"], "bin"

    # Create wrapper script that uses Homebrew's node
    (bin/"afm-js").write <<~EOS
      #!/bin/bash
      export AFM_JS_HELPER_PATH="#{opt_prefix}/libexec/afm-fm-helper"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/afm-js.js" "$@"
    EOS
    chmod 0755, bin/"afm-js"

    # Install helper binary from resource
    resource("afm-fm-helper").stage do
      libexec.install "afm-fm-helper"
    end
    chmod 0755, libexec/"afm-fm-helper"
  end

  def caveats
    <<~EOS
      afm-js requires:
        - macOS 26 (Tahoe) or later
        - Apple Silicon (M1+)
        - Apple Intelligence enabled in System Settings

      To start the server manually:
        afm-js serve --port 11434

      To run as a background service (auto-starts at login):
        brew services start afm-js

      Manage the service:
        brew services stop afm-js
        brew services restart afm-js
        brew services info afm-js
    EOS
  end

  service do
    run [opt_bin/"afm-js", "serve", "--port", "11434"]
    keep_alive true
    log_path var/"log/afm-js.log"
    error_log_path var/"log/afm-js-error.log"
    environment_variables AFM_JS_HELPER_PATH: opt_prefix/"libexec/afm-fm-helper"
    require_root false
  end

  test do
    # Test that the binary runs
    assert_match "afm-js", shell_output("#{bin}/afm-js --help")
    
    # Test health endpoint if server can start briefly
    # Note: This may fail if Apple Intelligence is not available
  end
end
