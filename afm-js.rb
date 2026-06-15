class AfmJs < Formula
  desc "Apple Foundation Models for Node.js — OpenAI-compatible HTTP server + CLI"
  homepage "https://github.com/tariqwest/afm-js"
  url "https://github.com/tariqwest/afm-js/releases/download/v0.0.1/afm-js-prebuilt-arm64-apple-darwin.tar.gz"
  sha256 "98b14bb56bb8c181abf7f3a7505559383a11a82be20ed72f9604bc283201ff92"
  license "MIT"
  version "0.0.1"

  depends_on "node"
  depends_on :macos
  depends_on arch: :arm64

  resource "afm-fm-helper" do
    url "https://github.com/tariqwest/afm-js/releases/download/v0.0.1/afm-fm-helper-arm64-apple-darwin.tar.gz"
    sha256 "5ad31aca8e0b05c71e6341cdc14ec001b1a29ac193ff81c8ea5d8d28d1dc52ad"
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

      To start the server:
        afm-js serve --port 11434

      For autostart with LaunchAgent:
        afm-js autostart --port 11434 --token sk-mine
    EOS
  end

  test do
    # Test that the binary runs
    assert_match "afm-js", shell_output("#{bin}/afm-js --help")
    
    # Test health endpoint if server can start briefly
    # Note: This may fail if Apple Intelligence is not available
  end
end
