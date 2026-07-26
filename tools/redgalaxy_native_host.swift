import Foundation
import Cocoa
import WebKit

final class RedGalaxyHostApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private var serverURL = "http://127.0.0.1:8765/"
    private var hasLoaded = false
    private var detectedPort = false
    private var outputBuffer = ""
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        buildWindow()
        launchServer()

        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.loadGamePage()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    private func buildWindow() {
        let frame = NSRect(x: 120, y: 120, width: 1280, height: 820)
        let style: NSWindow.StyleMask = [.titled, .closable, .resizable, .miniaturizable]
        let window = NSWindow(
            contentRect: frame,
            styleMask: style,
            backing: .buffered,
            defer: false
        )
        window.title = "RedGalaxy Native"
        window.minSize = NSSize(width: 960, height: 540)
        window.center()
        window.delegate = self

        let config = WKWebViewConfiguration()
        if #available(macOS 10.14, *) {
            config.mediaTypesRequiringUserActionForPlayback = []
        }

        let view = WKWebView(frame: window.contentView?.bounds ?? frame, configuration: config)
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        window.makeKeyAndOrderFront(nil)

        self.window = window
        self.webView = view
    }

    private func launchServer() {
        guard let serverPath = serverExecutablePath() else {
            NSLog("RedGalaxy native server not found in app bundle.")
            stopApplication()
            return
        }

        let userWebRoot = resolveUserWebRoot()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: serverPath)
        if let root = userWebRoot {
            process.arguments = ["--no-open", "--port", "8765", root]
            NSLog("Using user web root: \(root)")
        } else {
            process.arguments = ["--no-open", "--port", "8765"]
        }

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                return
            }
            let text = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.consumeServerOutput(text)
            }
        }

        do {
            try process.run()
            serverProcess = process
            NSLog("Started redgalaxy-native-server (pid=%d)", process.processIdentifier)
        } catch {
            NSLog("Failed to start server: \(error)")
            stopApplication()
        }
    }

    private func consumeServerOutput(_ text: String) {
        outputBuffer += text

        while let newline = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[..<newline])
            outputBuffer.removeSubrange(outputBuffer.startIndex...newline)
            parseServerLine(line)
        }
        parseServerLine(outputBuffer)
    }

    private func parseServerLine(_ line: String) {
        if !detectedPort, let port = extractPort(from: line) {
            detectedPort = true
            serverURL = "http://127.0.0.1:\(port)/"
            hasLoaded = false
            loadGamePage()
        }
    }

    private func loadGamePage() {
        guard !hasLoaded, let view = webView, let url = URL(string: serverURL) else {
            return
        }
        view.load(URLRequest(url: url))
        hasLoaded = true
    }

    private func extractPort(from line: String) -> Int? {
        let marker = "Open http://127.0.0.1:"
        guard let range = line.range(of: marker) else { return nil }
        let tail = String(line[range.upperBound...])
        if let slash = tail.firstIndex(of: "/") {
            let rawPort = String(tail[..<slash])
            return Int(rawPort)
        }
        return nil
    }

    private func serverExecutablePath() -> String? {
        let bundleRoot = URL(fileURLWithPath: Bundle.main.bundlePath)
        let candidate = bundleRoot
            .appendingPathComponent("Contents")
            .appendingPathComponent("MacOS")
            .appendingPathComponent("redgalaxy-native-server")
        return FileManager.default.isExecutableFile(atPath: candidate.path) ? candidate.path : nil
    }

    private func resolveUserWebRoot() -> String? {
        let fm = FileManager.default
        guard let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let root = appSupport
            .appendingPathComponent("RedGalaxy Native", isDirectory: true)
            .appendingPathComponent("web", isDirectory: true)
        let index = root.appendingPathComponent("index.html")
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else {
            return nil
        }
        guard fm.fileExists(atPath: index.path) else {
            return nil
        }
        return root.path
    }

    private func stopServer() {
        guard let process = serverProcess else {
            return
        }
        if !process.isRunning {
            return
        }
        process.terminate()
        if let stdoutPipe = process.standardOutput as? Pipe {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
        }
        if let stderrPipe = process.standardError as? Pipe {
            stderrPipe.fileHandleForReading.readabilityHandler = nil
        }
    }

    private func stopApplication() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = RedGalaxyHostApp()
app.delegate = delegate
app.run()
