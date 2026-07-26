#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <unistd.h>

@interface RedGalaxyHostApp : NSObject <NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler>
@property(strong) NSWindow *window;
@property(strong) WKWebView *webView;
@property(strong) NSTask *serverTask;
@property(strong) NSTask *updateTask;
@property(copy) NSString *serverURL;
@property(copy) NSString *activeWebRoot;
@property(assign) BOOL hasLoaded;
@property(assign) BOOL detectedPort;
@property(assign) BOOL updatePromptShown;
@property(strong) NSMutableString *outputBuffer;
@property(strong) NSMutableString *updateOutputBuffer;
@property(assign) id backgroundActivity;
@end

@implementation RedGalaxyHostApp

- (instancetype)init {
    self = [super init];
    if (self) {
        _serverURL = @"http://127.0.0.1:8765/";
        _outputBuffer = [NSMutableString string];
        _updateOutputBuffer = [NSMutableString string];
    }
    return self;
}

- (BOOL)isStoryBundle {
    NSString *bundleId = [[NSBundle mainBundle] bundleIdentifier];
    return [bundleId isEqualToString:@"local.redgalaxy.bastion"]
        || [bundleId isEqualToString:@"local.redgalaxy.story"];
}

- (NSString *)supportAppName {
    return [self isStoryBundle] ? @"RedGalaxy Bastion" : @"RedGalaxy Native";
}

- (NSString *)bundleWebRoot {
    return [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:@"Contents/Resources/web"];
}

- (NSString *)userWebRoot {
    NSArray<NSString *> *dirs = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    if (dirs.count == 0) {
        return nil;
    }
    return [[dirs[0] stringByAppendingPathComponent:[self supportAppName]] stringByAppendingPathComponent:@"web"];
}

- (BOOL)webRootLooksValid:(NSString *)webRoot requireStory:(BOOL)requireStory {
    if (webRoot.length == 0) {
        return NO;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isDir = NO;
    NSString *index = [webRoot stringByAppendingPathComponent:@"index.html"];
    if (!( [fm fileExistsAtPath:webRoot isDirectory:&isDir] && isDir && [fm fileExistsAtPath:index] )) {
        return NO;
    }
    if (requireStory) {
        // Preferring App Support requires a *complete* Bastion overlay, not just
        // story/autopilot.js sitting on an unpatched game extract.
        return [self bastionWebRootIsIntact:webRoot];
    }
    return YES;
}

/**
 * True when Bastion can actually run: story files + index script tags + game hooks.
 * A cache with only story/ copied onto raw game assets is NOT intact.
 */
- (BOOL)bastionWebRootIsIntact:(NSString *)webRoot {
    if (webRoot.length == 0) {
        return NO;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *indexPath = [webRoot stringByAppendingPathComponent:@"index.html"];
    NSString *autopilot = [webRoot stringByAppendingPathComponent:@"story/autopilot.js"];
    NSString *i18n = [webRoot stringByAppendingPathComponent:@"story/i18n.js"];
    if (![fm fileExistsAtPath:indexPath] || ![fm fileExistsAtPath:autopilot] || ![fm fileExistsAtPath:i18n]) {
        return NO;
    }
    NSString *html = [NSString stringWithContentsOfFile:indexPath encoding:NSUTF8StringEncoding error:nil];
    if (html.length == 0 ||
        [html rangeOfString:@"__RG_STORY_MODE__"].location == NSNotFound ||
        [html rangeOfString:@"/story/i18n.js"].location == NSNotFound ||
        [html rangeOfString:@"/story/autopilot.js"].location == NSNotFound) {
        return NO;
    }

    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"/assets/(index-[^\"']+\\.js)"
                                                                        options:0
                                                                          error:nil];
    NSTextCheckingResult *match = [re firstMatchInString:html options:0 range:NSMakeRange(0, html.length)];
    if (!match || match.numberOfRanges < 2) {
        return NO;
    }
    NSString *assetName = [html substringWithRange:[match rangeAtIndex:1]];
    NSString *assetPath = [[webRoot stringByAppendingPathComponent:@"assets"] stringByAppendingPathComponent:assetName];
    NSString *js = [NSString stringWithContentsOfFile:assetPath encoding:NSUTF8StringEncoding error:nil];
    if (js.length == 0 ||
        [js rangeOfString:@"__RG_GAME__"].location == NSNotFound ||
        [js rangeOfString:@"__RG_NET__"].location == NSNotFound) {
        return NO;
    }
    return YES;
}

- (NSString *)preferredWebRoot {
    NSString *userWeb = [self userWebRoot];
    if ([self webRootLooksValid:userWeb requireStory:[self isStoryBundle]]) {
        return userWeb;
    }
    return [self bundleWebRoot];
}

- (BOOL)storyFile:(NSString *)name matchesBundleInUserStory:(NSString *)userStory bundleStory:(NSString *)bundleStory {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *bundlePath = [bundleStory stringByAppendingPathComponent:name];
    NSString *userPath = [userStory stringByAppendingPathComponent:name];
    if (![fm fileExistsAtPath:bundlePath]) {
        return YES; // nothing to sync for this file
    }
    if (![fm fileExistsAtPath:userPath]) {
        return NO;
    }
    return [fm contentsEqualAtPath:bundlePath andPath:userPath];
}

/**
 * Prefer .bastion-stamp (content hash). Missing stamp on either side = stale cache
 * that must be refreshed from the running app bundle — markers alone are not enough.
 */
- (BOOL)storyStampMatchesBundleInUserStory:(NSString *)userStory bundleStory:(NSString *)bundleStory {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *bundleStamp = [bundleStory stringByAppendingPathComponent:@".bastion-stamp"];
    NSString *userStamp = [userStory stringByAppendingPathComponent:@".bastion-stamp"];
    if (![fm fileExistsAtPath:bundleStamp]) {
        // Older bundles without stamp: fall back to critical file bytes only.
        return YES;
    }
    if (![fm fileExistsAtPath:userStamp]) {
        return NO;
    }
    return [fm contentsEqualAtPath:bundleStamp andPath:userStamp];
}

/**
 * Bastion/Story always prefer Application Support/web when present (game updates).
 * Re-copy the running app's bundled story overlay into the cache when the Bastion
 * stamp or any critical story file is missing/mismatched so DMG rebuilds win.
 */
- (BOOL)syncBundledStoryOverlayIntoUserWeb {
    if (![self isStoryBundle]) {
        return NO;
    }
    NSString *userWeb = [self userWebRoot];
    NSString *bundleStory = [[self bundleWebRoot] stringByAppendingPathComponent:@"story"];
    NSString *userStory = [userWeb stringByAppendingPathComponent:@"story"];
    if (userWeb.length == 0 || bundleStory.length == 0) {
        return NO;
    }

    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isDir = NO;
    if (![fm fileExistsAtPath:bundleStory isDirectory:&isDir] || !isDir) {
        return NO;
    }
    // Only touch Application Support when it is already the active game root.
    if (![self webRootLooksValid:userWeb requireStory:NO]) {
        return NO;
    }

    BOOL stampMatches = [self storyStampMatchesBundleInUserStory:userStory bundleStory:bundleStory];
    BOOL storyMatches =
        stampMatches &&
        [self storyFile:@"autopilot.js" matchesBundleInUserStory:userStory bundleStory:bundleStory] &&
        [self storyFile:@"i18n.js" matchesBundleInUserStory:userStory bundleStory:bundleStory] &&
        [self storyFile:@"map_graph.json" matchesBundleInUserStory:userStory bundleStory:bundleStory];
    if (storyMatches) {
        NSLog(@"Story overlay already matches bundle: %@", userStory);
        return NO;
    }

    NSError *error = nil;
    NSString *staging = [userWeb stringByAppendingPathComponent:@".story-sync-tmp"];
    [fm removeItemAtPath:staging error:nil];
    if (![fm copyItemAtPath:bundleStory toPath:staging error:&error]) {
        NSLog(@"Failed to stage bundled story overlay: %@", error);
        return NO;
    }
    if ([fm fileExistsAtPath:userStory]) {
        if (![fm removeItemAtPath:userStory error:&error]) {
            NSLog(@"Failed to remove stale story overlay: %@", error);
            [fm removeItemAtPath:staging error:nil];
            return NO;
        }
    }
    if (![fm moveItemAtPath:staging toPath:userStory error:&error]) {
        NSLog(@"Failed to install bundled story overlay: %@", error);
        [fm removeItemAtPath:staging error:nil];
        return NO;
    }
    NSLog(@"Synced bundled story overlay into %@ (stamp/content refresh)", userStory);
    return YES;
}

/**
 * If App Support has game assets but Bastion patches/hooks are missing (typical after
 * an extract that skipped re-patch, or a wiped story + sync-only restore), re-apply
 * apply_bastion_patches.py in place from the current app bundle.
 * Also re-patches when story stamp/content still mismatches after sync.
 * Returns YES when a repair was performed successfully.
 */
- (BOOL)ensureBastionOverlayInUserWeb {
    if (![self isStoryBundle]) {
        return NO;
    }
    NSString *userWeb = [self userWebRoot];
    if (![self webRootLooksValid:userWeb requireStory:NO]) {
        return NO;
    }

    NSString *bundleStory = [[self bundleWebRoot] stringByAppendingPathComponent:@"story"];
    NSString *userStory = [userWeb stringByAppendingPathComponent:@"story"];
    BOOL stampOk = [self storyStampMatchesBundleInUserStory:userStory bundleStory:bundleStory];
    BOOL filesOk =
        [self storyFile:@"autopilot.js" matchesBundleInUserStory:userStory bundleStory:bundleStory] &&
        [self storyFile:@"i18n.js" matchesBundleInUserStory:userStory bundleStory:bundleStory] &&
        [self storyFile:@"map_graph.json" matchesBundleInUserStory:userStory bundleStory:bundleStory];
    BOOL storyFresh = stampOk && filesOk;

    if ([self bastionWebRootIsIntact:userWeb] && storyFresh) {
        return NO;
    }

    NSString *patcher = [[[NSBundle mainBundle] bundlePath]
        stringByAppendingPathComponent:@"Contents/Resources/apply_bastion_patches.py"];
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm isReadableFileAtPath:patcher] || ![fm fileExistsAtPath:bundleStory]) {
        NSLog(@"Cannot repair Bastion overlay: missing patcher or bundled story");
        return NO;
    }

    NSTask *task = [[NSTask alloc] init];
    task.launchPath = @"/usr/bin/env";
    task.arguments = @[ @"python3", patcher, @"--in-place", userWeb, @"--story-src", bundleStory ];
    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    if (env == nil) {
        env = [NSMutableDictionary dictionary];
    }
    env[@"PATH"] = [self augmentedUpdaterPATH];
    task.environment = env;
    task.standardOutput = [NSPipe pipe];
    task.standardError = task.standardOutput;

    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        NSLog(@"Failed to launch Bastion patcher: %@", error);
        return NO;
    }
    [task waitUntilExit];
    if (task.terminationStatus != 0) {
        NSLog(@"Bastion in-place repair failed with status %d", task.terminationStatus);
        return NO;
    }
    if (![self bastionWebRootIsIntact:userWeb]) {
        NSLog(@"Bastion in-place repair finished but overlay still incomplete");
        return NO;
    }
    NSLog(@"Repaired Bastion overlay in place at %@", userWeb);
    return YES;
}

- (void)refreshBastionOverlayFromBundle {
    if (![self isStoryBundle]) {
        return;
    }
    [self syncBundledStoryOverlayIntoUserWeb];
    [self ensureBastionOverlayInUserWeb];
}

- (void)beginBackgroundActivityIfNeeded {
    if (self.backgroundActivity != nil) {
        return;
    }
    if (![self isStoryBundle]) {
        return;
    }
    NSActivityOptions options = NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical;
    self.backgroundActivity = [[NSProcessInfo processInfo] beginActivityWithOptions:options
                                                                             reason:@"RedGalaxy Bastion autopilot"];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp activateIgnoringOtherApps:YES];

    [self beginBackgroundActivityIfNeeded];
    [self buildMenus];
    [self buildWindow];
    [self refreshBastionOverlayFromBundle];
    [self launchServerWithWebRoot:[self preferredWebRoot]];

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self loadGamePage];
    });

    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [self checkForUpdatesIfNeeded];
    });
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    (void)sender;
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    (void)notification;
    if (self.backgroundActivity != nil) {
        [[NSProcessInfo processInfo] endActivity:self.backgroundActivity];
        self.backgroundActivity = nil;
    }
    [self stopServer];
}

- (void)buildMenus {
    NSMenu *menubar = [[NSMenu alloc] init];
    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [menubar addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    NSString *quitTitle = [NSString stringWithFormat:@"Esci da %@", [self isStoryBundle] ? @"RedGalaxy Bastion" : @"RedGalaxy Native"];
    NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:quitTitle
                                                      action:@selector(terminate:)
                                               keyEquivalent:@"q"];
    [appMenu addItem:quitItem];
    appItem.submenu = appMenu;

    NSMenuItem *gameTop = [[NSMenuItem alloc] init];
    [menubar addItem:gameTop];
    NSMenu *gameMenu = [[NSMenu alloc] initWithTitle:@"Gioco"];
    NSMenuItem *updateItem = [[NSMenuItem alloc] initWithTitle:@"Aggiorna gioco…"
                                                        action:@selector(menuUpdateGame:)
                                                 keyEquivalent:@"u"];
    updateItem.target = self;
    [gameMenu addItem:updateItem];
    if ([self isStoryBundle]) {
        NSMenuItem *bastionUpdateItem = [[NSMenuItem alloc] initWithTitle:@"Aggiorna Bastion…"
                                                                   action:@selector(menuUpdateBastion:)
                                                            keyEquivalent:@"b"];
        bastionUpdateItem.target = self;
        [gameMenu addItem:bastionUpdateItem];
    }
    gameTop.submenu = gameMenu;

    NSApp.mainMenu = menubar;
}

- (void)menuUpdateGame:(id)sender {
    (void)sender;
    [self startBundledUpdaterForced:YES];
}

- (void)menuUpdateBastion:(id)sender {
    (void)sender;
    [self startBastionSelfUpdate];
}

- (void)buildWindow {
    NSRect frame = NSMakeRect(120, 120, 1280, 820);
    NSWindowStyleMask style = NSWindowStyleMaskTitled |
        NSWindowStyleMaskClosable |
        NSWindowStyleMaskResizable |
        NSWindowStyleMaskMiniaturizable;

    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = [self isStoryBundle] ? @"RedGalaxy Bastion" : @"RedGalaxy Native";
    self.window.minSize = NSMakeSize(960, 540);
    self.window.delegate = self;
    [self.window center];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    [config.userContentController addScriptMessageHandler:self name:@"bastionHost"];

    NSView *contentView = self.window.contentView;
    self.webView = [[WKWebView alloc] initWithFrame:contentView.bounds configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.window.contentView = self.webView;
    [self.window makeKeyAndOrderFront:nil];
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)userContentController;
    if (![message.name isEqualToString:@"bastionHost"]) {
        return;
    }
    id body = message.body;
    NSString *action = nil;
    if ([body isKindOfClass:[NSDictionary class]]) {
        id raw = [(NSDictionary *)body objectForKey:@"action"];
        if ([raw isKindOfClass:[NSString class]]) {
            action = (NSString *)raw;
        }
    } else if ([body isKindOfClass:[NSString class]]) {
        action = (NSString *)body;
    }
    if ([action isEqualToString:@"updateGame"] || [action isEqualToString:@"checkUpdate"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self startBundledUpdaterForced:YES];
        });
    } else if ([action isEqualToString:@"updateBastion"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self startBastionSelfUpdate];
        });
    }
}

- (void)launchServerWithWebRoot:(NSString *)webRoot {
    NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
    NSString *serverPath = [bundlePath stringByAppendingPathComponent:@"Contents/MacOS/redgalaxy-native-server"];
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:serverPath]) {
        NSLog(@"RedGalaxy native server not found: %@", serverPath);
        [NSApp terminate:nil];
        return;
    }

    NSString *resolved = webRoot;
    if (![self webRootLooksValid:resolved requireStory:NO]) {
        resolved = [self bundleWebRoot];
    }
    self.activeWebRoot = resolved;

    NSPipe *pipe = [NSPipe pipe];
    self.serverTask = [[NSTask alloc] init];
    self.serverTask.launchPath = serverPath;
    self.serverTask.arguments = @[@"--no-open", @"--port", @"8765", resolved];
    NSLog(@"Serving web root: %@", resolved);
    self.serverTask.standardOutput = pipe;
    self.serverTask.standardError = pipe;

    __weak typeof(self) weakSelf = self;
    pipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = [handle availableData];
        if (data.length == 0) {
            return;
        }
        NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!text) {
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf consumeServerOutput:text];
        });
    };

    NSError *error = nil;
    if (![self.serverTask launchAndReturnError:&error]) {
        NSLog(@"Failed to start RedGalaxy native server: %@", error);
        [NSApp terminate:nil];
        return;
    }
}

- (void)restartServerWithPreferredWebRoot {
    [self stopServer];
    self.detectedPort = NO;
    self.hasLoaded = NO;
    self.outputBuffer = [NSMutableString string];
    [self refreshBastionOverlayFromBundle];
    [self launchServerWithWebRoot:[self preferredWebRoot]];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self loadGamePage];
    });
}

- (void)consumeServerOutput:(NSString *)text {
    [self.outputBuffer appendString:text];

    while (true) {
        NSRange newline = [self.outputBuffer rangeOfString:@"\n"];
        if (newline.location == NSNotFound) {
            break;
        }
        NSString *line = [self.outputBuffer substringToIndex:newline.location];
        [self.outputBuffer deleteCharactersInRange:NSMakeRange(0, newline.location + newline.length)];
        [self parseServerLine:line];
    }

    [self parseServerLine:self.outputBuffer];
}

- (void)parseServerLine:(NSString *)line {
    if (self.detectedPort) {
        return;
    }

    NSString *marker = @"Open http://127.0.0.1:";
    NSRange markerRange = [line rangeOfString:marker];
    if (markerRange.location == NSNotFound) {
        return;
    }

    NSUInteger portStart = markerRange.location + markerRange.length;
    NSString *tail = [line substringFromIndex:portStart];
    NSRange slashRange = [tail rangeOfString:@"/"];
    NSString *port = slashRange.location == NSNotFound ? tail : [tail substringToIndex:slashRange.location];
    NSInteger portNumber = [port integerValue];
    if (portNumber <= 0 || portNumber > 65535) {
        return;
    }

    self.detectedPort = YES;
    self.hasLoaded = NO;
    self.serverURL = [NSString stringWithFormat:@"http://127.0.0.1:%ld/", (long)portNumber];
    [self loadGamePage];
}

- (void)loadGamePage {
    if (self.hasLoaded || !self.webView) {
        return;
    }
    NSString *target = self.serverURL;
    NSURL *url = [NSURL URLWithString:target];
    if (!url) {
        return;
    }
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
    self.hasLoaded = YES;
}

- (void)stopServer {
    if (!self.serverTask || !self.serverTask.isRunning) {
        return;
    }
    NSPipe *pipe = (NSPipe *)self.serverTask.standardOutput;
    pipe.fileHandleForReading.readabilityHandler = nil;
    [self.serverTask terminate];
    self.serverTask = nil;
}

- (NSString *)versionFilePath {
    NSArray<NSString *> *dirs = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    if (dirs.count == 0) {
        return nil;
    }
    return [[dirs[0] stringByAppendingPathComponent:[self supportAppName]] stringByAppendingPathComponent:@"version.txt"];
}

- (NSString *)versionFromAssetsInWebRoot:(NSString *)webRoot {
    if (webRoot.length == 0) {
        return nil;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    // Prefer the entry chunk referenced by index.html (leftover index-*.js can be stale).
    NSString *indexPath = [webRoot stringByAppendingPathComponent:@"index.html"];
    NSString *html = [NSString stringWithContentsOfFile:indexPath encoding:NSUTF8StringEncoding error:nil];
    if (html.length > 0) {
        NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"/assets/(index-[^\"']+\\.js)"
                                                                            options:0
                                                                              error:nil];
        NSTextCheckingResult *match = [re firstMatchInString:html options:0 range:NSMakeRange(0, html.length)];
        if (match && match.numberOfRanges >= 2) {
            NSString *assetName = [html substringWithRange:[match rangeAtIndex:1]];
            NSString *assetPath = [[webRoot stringByAppendingPathComponent:@"assets"] stringByAppendingPathComponent:assetName];
            NSString *content = [NSString stringWithContentsOfFile:assetPath encoding:NSUTF8StringEncoding error:nil];
            if (content.length > 0) {
                NSRange marker = [content rangeOfString:@"redgalaxy-client@"];
                if (marker.location != NSNotFound) {
                    NSString *tail = [content substringFromIndex:marker.location + marker.length];
                    NSCharacterSet *stopSet = [NSCharacterSet characterSetWithCharactersInString:@"+\"'\\s"];
                    NSRange stop = [tail rangeOfCharacterFromSet:stopSet];
                    NSString *version = stop.location == NSNotFound ? tail : [tail substringToIndex:stop.location];
                    version = [version stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                    // Strip build metadata if somehow still present
                    NSRange dash = [version rangeOfString:@"-"];
                    if (dash.location != NSNotFound) {
                        version = [version substringToIndex:dash.location];
                    }
                    if (version.length > 0) {
                        return version;
                    }
                }
            }
        }
    }

    NSString *assets = [webRoot stringByAppendingPathComponent:@"assets"];
    NSArray<NSString *> *matches = [fm contentsOfDirectoryAtPath:assets error:nil];
    for (NSString *name in matches) {
        if (![name hasPrefix:@"index-"] || ![name hasSuffix:@".js"]) {
            continue;
        }
        NSString *path = [assets stringByAppendingPathComponent:name];
        NSString *content = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
        if (content.length == 0) {
            continue;
        }
        NSRange marker = [content rangeOfString:@"redgalaxy-client@"];
        if (marker.location == NSNotFound) {
            continue;
        }
        NSString *tail = [content substringFromIndex:marker.location + marker.length];
        NSCharacterSet *stopSet = [NSCharacterSet characterSetWithCharactersInString:@"+\"'"];
        NSRange stop = [tail rangeOfCharacterFromSet:stopSet];
        NSString *version = stop.location == NSNotFound ? tail : [tail substringToIndex:stop.location];
        version = [version stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (version.length > 0) {
            return version;
        }
    }
    return nil;
}

- (BOOL)gameWebLooksCorrupt:(NSString *)webRoot {
    if (webRoot.length == 0) {
        return YES;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:[webRoot stringByAppendingPathComponent:@"index.html"]] ||
        ![fm fileExistsAtPath:[webRoot stringByAppendingPathComponent:@"assets"]] ||
        ![fm fileExistsAtPath:[webRoot stringByAppendingPathComponent:@"maps"]] ||
        ![fm fileExistsAtPath:[webRoot stringByAppendingPathComponent:@"ships"]]) {
        return YES;
    }
    // Missing locales / woff2 → incomplete extract; WKWebView hangs on fonts.load (black screen).
    NSString *langTr = [webRoot stringByAppendingPathComponent:@"lang/tr.json"];
    NSString *langEn = [webRoot stringByAppendingPathComponent:@"lang/en.json"];
    if (![fm fileExistsAtPath:langTr] && ![fm fileExistsAtPath:langEn]) {
        return YES;
    }
    NSString *assetsDir = [webRoot stringByAppendingPathComponent:@"assets"];
    NSArray<NSString *> *assetNames = [fm contentsOfDirectoryAtPath:assetsDir error:nil];
    BOOL hasWoff2 = NO;
    for (NSString *name in assetNames) {
        if ([name hasSuffix:@".woff2"]) {
            hasWoff2 = YES;
            break;
        }
    }
    if (!hasWoff2) {
        return YES;
    }
    // Fused extract path leftovers (e.g. *.atlasships*) mean incomplete game assets.
    NSDirectoryEnumerator *en = [fm enumeratorAtPath:webRoot];
    NSString *rel = nil;
    NSUInteger checked = 0;
    while ((rel = [en nextObject]) != nil && checked < 5000) {
        checked += 1;
        if ([rel rangeOfString:@"atlasships"].location != NSNotFound ||
            [rel rangeOfString:@"jsonships"].location != NSNotFound ||
            [rel rangeOfString:@"webpships"].location != NSNotFound) {
            return YES;
        }
    }
    return NO;
}

- (NSString *)installedClientVersion {
    // Live game web embed is source of truth — version.txt can lie after partial updates.
    NSString *fromUser = [self versionFromAssetsInWebRoot:[self userWebRoot]];
    if (fromUser.length > 0) {
        return fromUser;
    }
    NSString *fromBundle = [self versionFromAssetsInWebRoot:[self bundleWebRoot]];
    if (fromBundle.length > 0) {
        return fromBundle;
    }
    NSString *versionFile = [self versionFilePath];
    NSString *stored = [NSString stringWithContentsOfFile:versionFile encoding:NSUTF8StringEncoding error:nil];
    stored = [[stored stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] copy];
    if (stored.length > 0) {
        return stored;
    }
    return nil;
}

- (NSInteger)compareVersion:(NSString *)left to:(NSString *)right {
    NSArray<NSString *> *leftParts = [left componentsSeparatedByString:@"."];
    NSArray<NSString *> *rightParts = [right componentsSeparatedByString:@"."];
    NSUInteger count = MAX(leftParts.count, rightParts.count);
    for (NSUInteger i = 0; i < count; i++) {
        NSInteger leftValue = i < leftParts.count ? [leftParts[i] integerValue] : 0;
        NSInteger rightValue = i < rightParts.count ? [rightParts[i] integerValue] : 0;
        if (leftValue < rightValue) {
            return -1;
        }
        if (leftValue > rightValue) {
            return 1;
        }
    }
    return 0;
}

- (NSString *)fetchLatestClientVersion {
    NSURL *url = [NSURL URLWithString:@"https://updates.redgalaxygame.space/latest.json"];
    if (!url) {
        return nil;
    }

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"GET";
    [request setValue:@"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RedGalaxy-Bastion-Updater/1.0" forHTTPHeaderField:@"User-Agent"];
    request.timeoutInterval = 20.0;

    __block NSData *payload = nil;
    __block NSError *requestError = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        (void)response;
        payload = data;
        requestError = error;
        dispatch_semaphore_signal(sem);
    }] resume];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    if (requestError || payload.length == 0) {
        NSLog(@"Update check failed: %@", requestError);
        return nil;
    }

    id json = [NSJSONSerialization JSONObjectWithData:payload options:0 error:nil];
    if (![json isKindOfClass:[NSDictionary class]]) {
        return nil;
    }
    id version = json[@"version"];
    if (![version isKindOfClass:[NSString class]]) {
        return nil;
    }
    return [(NSString *)version stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

- (void)checkForUpdatesIfNeeded {
    if (self.updatePromptShown) {
        return;
    }

    NSString *installed = [self installedClientVersion];
    NSString *latest = [self fetchLatestClientVersion];
    if (latest.length == 0) {
        return;
    }
    if (installed.length > 0 && [self compareVersion:installed to:latest] >= 0) {
        return;
    }

    self.updatePromptShown = YES;
    dispatch_async(dispatch_get_main_queue(), ^{
        [self promptForUpdateFrom:installed to:latest];
    });
}

- (void)promptForUpdateFrom:(NSString *)installed to:(NSString *)latest {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleInformational;
    alert.messageText = [self isStoryBundle]
        ? @"Aggiornamento gioco disponibile"
        : @"Aggiornamento RedGalaxy disponibile";
    NSString *extra = [self isStoryBundle]
        ? @"\n\nVerranno aggiornati solo gli asset ufficiali del gioco. Autopilot, licenza e UI Bastion restano intatti."
        : @"";
    if (installed.length > 0) {
        alert.informativeText = [NSString stringWithFormat:@"Versione installata: %@\nNuova versione ufficiale: %@%@\n\nVuoi scaricare e applicare l'aggiornamento adesso?", installed, latest, extra];
    } else {
        alert.informativeText = [NSString stringWithFormat:@"Nuova versione ufficiale: %@%@\n\nVuoi scaricare e applicare l'aggiornamento adesso?", latest, extra];
    }
    [alert addButtonWithTitle:@"Aggiorna ora"];
    [alert addButtonWithTitle:@"Più tardi"];

    NSModalResponse response = [alert runModal];
    if (response != NSAlertFirstButtonReturn) {
        return;
    }
    [self startBundledUpdaterForced:NO];
}

- (NSString *)augmentedUpdaterPATH {
    NSString *existing = [[[NSProcessInfo processInfo] environment] objectForKey:@"PATH"] ?: @"";
    NSString *resources = [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:@"Contents/Resources"];
    NSArray<NSString *> *extras = @[
        [resources stringByAppendingPathComponent:@"brotli/bin"],
        @"/opt/homebrew/bin",
        @"/usr/local/bin",
        @"/opt/homebrew/sbin",
        @"/usr/local/sbin",
        @"/usr/bin",
        @"/bin",
        @"/usr/sbin",
        @"/sbin",
    ];
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    void (^appendPath)(NSString *) = ^(NSString *entry) {
        if (entry.length == 0 || [seen containsObject:entry]) {
            return;
        }
        [seen addObject:entry];
        [parts addObject:entry];
    };
    for (NSString *entry in extras) {
        appendPath(entry);
    }
    for (NSString *entry in [existing componentsSeparatedByString:@":"]) {
        appendPath(entry);
    }
    return [parts componentsJoinedByString:@":"];
}

- (NSString *)shortErrorFromUpdaterOutput:(NSString *)output {
    if (output.length == 0) {
        return nil;
    }
    NSArray<NSString *> *lines = [output componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]];
    NSString *fallback = nil;
    for (NSString *raw in [lines reverseObjectEnumerator]) {
        NSString *line = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (line.length == 0) {
            continue;
        }
        NSRange errorRange = [line rangeOfString:@"ERROR:" options:NSCaseInsensitiveSearch];
        if (errorRange.location != NSNotFound) {
            NSString *msg = [[line substringFromIndex:NSMaxRange(errorRange)]
                stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
            if (msg.length > 0) {
                if (msg.length > 280) {
                    msg = [[msg substringToIndex:277] stringByAppendingString:@"..."];
                }
                return msg;
            }
        }
        if (fallback == nil && ([line.lowercaseString containsString:@"brotli"] || [line.lowercaseString containsString:@"failed"])) {
            fallback = line;
        }
    }
    if (fallback.length > 280) {
        return [[fallback substringToIndex:277] stringByAppendingString:@"..."];
    }
    return fallback;
}

- (void)startBundledUpdaterForced:(BOOL)forced {
    NSString *runner = [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:@"Contents/Resources/redgalaxy-mac-runner"];
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:runner]) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = @"Aggiornamento non disponibile";
        alert.informativeText = [self isStoryBundle]
            ? @"Questa copia di Bastion non contiene lo strumento di aggiornamento. Ricostruisci il DMG o esegui: REDGALAXY_BASTION=1 ./bin/redgalaxy-mac-runner update-bastion --yes --silent"
            : @"Questa copia di RedGalaxy Native non contiene lo strumento di aggiornamento. Ricostruisci il DMG o esegui: ./bin/redgalaxy-mac-runner update-native --yes --silent";
        [alert runModal];
        return;
    }

    if (self.updateTask.isRunning) {
        return;
    }

    if (forced) {
        NSString *installed = [self installedClientVersion];
        NSString *latest = [self fetchLatestClientVersion];
        BOOL corrupt = [self gameWebLooksCorrupt:[self userWebRoot]];
        BOOL behind = latest.length > 0 && installed.length > 0 && [self compareVersion:installed to:latest] < 0;
        BOOL missingLive = installed.length == 0;

        // Only claim "già aggiornato" when live GAME web embed matches official
        // and assets are not corrupt — ignore a lying version.txt.
        if (latest.length > 0 && installed.length > 0 && !behind && !corrupt && !missingLive &&
            [self compareVersion:installed to:latest] >= 0) {
            BOOL storySynced = [self syncBundledStoryOverlayIntoUserWeb];
            BOOL overlayRepaired = [self ensureBastionOverlayInUserWeb];
            NSAlert *alert = [[NSAlert alloc] init];
            alert.alertStyle = NSAlertStyleInformational;
            alert.messageText = @"Gioco già aggiornato";
            if (storySynced || overlayRepaired) {
                alert.informativeText = [NSString stringWithFormat:
                    @"Client di gioco attuale: %@\nUltima ufficiale: %@\n\nOverlay Bastion ripristinato dal bundle. Ricarico la finestra.",
                    installed, latest];
                [alert runModal];
                [self restartServerWithPreferredWebRoot];
            } else {
                alert.informativeText = [NSString stringWithFormat:@"Client di gioco attuale: %@\nUltima ufficiale: %@", installed, latest];
                [alert runModal];
            }
            return;
        }
        if (corrupt || behind || missingLive) {
            NSLog(@"Forcing game update: live=%@ official=%@ corrupt=%d", installed, latest, corrupt ? 1 : 0);
        }
    }

    [self.updateOutputBuffer setString:@""];

    NSPipe *pipe = [NSPipe pipe];
    self.updateTask = [[NSTask alloc] init];
    self.updateTask.launchPath = @"/bin/bash";
    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    if (env == nil) {
        env = [NSMutableDictionary dictionary];
    }
    env[@"PATH"] = [self augmentedUpdaterPATH];
    // Do not force BROTLI=bundled here: the runner smoke-tests candidates and
    // prefers a working Homebrew/system brotli over a broken bundle copy.
    if ([self isStoryBundle]) {
        self.updateTask.arguments = @[runner, @"update-bastion", @"--yes", @"--silent"];
        env[@"REDGALAXY_BASTION"] = @"1";
    } else {
        self.updateTask.arguments = @[runner, @"update-native", @"--yes", @"--silent"];
    }
    self.updateTask.environment = env;
    self.updateTask.standardOutput = pipe;
    self.updateTask.standardError = pipe;

    __weak typeof(self) weakSelf = self;
    pipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = [handle availableData];
        if (data.length == 0) {
            return;
        }
        NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (text.length > 0) {
            NSLog(@"RedGalaxy updater: %@", text);
            dispatch_async(dispatch_get_main_queue(), ^{
                [weakSelf.updateOutputBuffer appendString:text];
            });
        }
    };

    self.updateTask.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            pipe.fileHandleForReading.readabilityHandler = nil;
            NSAlert *alert = [[NSAlert alloc] init];
            if (task.terminationStatus == 0) {
                alert.alertStyle = NSAlertStyleInformational;
                alert.messageText = @"Aggiornamento completato";
                if ([weakSelf isStoryBundle]) {
                    alert.informativeText = @"Gli asset ufficiali del gioco sono stati aggiornati. Autopilot Bastion è stato riapplicato. Ricarico la finestra di gioco.";
                } else {
                    alert.informativeText = @"Gli asset ufficiali del gioco sono stati aggiornati. Ricarico la finestra di gioco.";
                }
                [alert runModal];
                [weakSelf restartServerWithPreferredWebRoot];
                return;
            } else {
                alert.alertStyle = NSAlertStyleWarning;
                alert.messageText = @"Aggiornamento non riuscito";
                NSString *shortError = [weakSelf shortErrorFromUpdaterOutput:weakSelf.updateOutputBuffer];
                NSString *logHint = [weakSelf isStoryBundle]
                    ? @"Dettagli nei log: ~/Library/Logs/RedGalaxy Bastion. L'app continua a usare gli asset inclusi nel bundle."
                    : @"Dettagli nei log: ~/Library/Logs/RedGalaxy Native. L'app continua a usare gli asset inclusi nel bundle.";
                if (shortError.length > 0) {
                    alert.informativeText = [NSString stringWithFormat:@"%@\n\n%@", shortError, logHint];
                } else {
                    alert.informativeText = logHint;
                }
            }
            [alert runModal];
        });
    };

    @try {
        [self.updateTask launch];
    } @catch (NSException *exception) {
        NSLog(@"Failed to launch updater: %@", exception);
    }

    NSAlert *progress = [[NSAlert alloc] init];
    progress.alertStyle = NSAlertStyleInformational;
    progress.messageText = @"Aggiornamento avviato";
    progress.informativeText = @"Scarico e applico la versione ufficiale. L'operazione può richiedere alcuni minuti (al primo avvio può scaricare anche Wine locale).";
    [progress runModal];
}

/**
 * Bastion host self-update (separate from "Aggiorna gioco").
 * Configure via env BASTION_UPDATE_MANIFEST_URL to override the default RGBastion URL.
 * Manifest: { "version", "dmg", "exe", "notes?", "releaseUrl?" }
 * Example: tools/bastion-update-manifest.example.json
 */
- (NSString *)bastionAppVersion {
    NSString *v = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    v = [v stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    return v.length > 0 ? v : @"1.0.5";
}

- (NSString *)playerSafeBastionNotes:(NSString *)notes {
    NSString *trimmed = [notes stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (trimmed.length == 0) {
        return @"";
    }
    NSString *lower = trimmed.lowercaseString;
    NSArray<NSString *> *blocked = @[
        @"upload this file", @"release asset", @"bump version", @"OWNER/REPO",
        @"github.com/", @"trascina", @"developer", @"ricostruisci", @"manifest"
    ];
    for (NSString *needle in blocked) {
        if ([lower containsString:needle.lowercaseString]) {
            return @"";
        }
    }
    return trimmed;
}

- (BOOL)directoryIsWritable:(NSString *)dir {
    if (dir.length == 0) {
        return NO;
    }
    return [[NSFileManager defaultManager] isWritableFileAtPath:dir];
}

- (BOOL)pathLooksLikeMountedDiskImage:(NSString *)path {
    return [path hasPrefix:@"/Volumes/"];
}

- (NSString *)bastionAppInstallDestination {
    NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
    NSString *parent = [bundlePath stringByDeletingLastPathComponent];
    NSString *appName = [bundlePath lastPathComponent];
    if (appName.length == 0) {
        appName = @"RedGalaxy Bastion.app";
    }

    if (![self pathLooksLikeMountedDiskImage:bundlePath] && [self directoryIsWritable:parent]) {
        return [parent stringByAppendingPathComponent:appName];
    }

    NSString *applications = @"/Applications";
    if ([self directoryIsWritable:applications]) {
        return [applications stringByAppendingPathComponent:@"RedGalaxy Bastion.app"];
    }

    NSArray<NSString *> *userApps = NSSearchPathForDirectoriesInDomains(NSApplicationDirectory, NSUserDomainMask, YES);
    if (userApps.count > 0 && [self directoryIsWritable:userApps[0]]) {
        return [userApps[0] stringByAppendingPathComponent:@"RedGalaxy Bastion.app"];
    }

    return [applications stringByAppendingPathComponent:@"RedGalaxy Bastion.app"];
}

- (NSString *)runShellCommand:(NSString *)launchPath arguments:(NSArray<NSString *> *)arguments output:(NSString **)outOutput {
    NSTask *task = [[NSTask alloc] init];
    task.launchPath = launchPath;
    task.arguments = arguments ?: @[];
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = pipe;
    @try {
        [task launch];
        [task waitUntilExit];
    } @catch (NSException *ex) {
        if (outOutput) {
            *outOutput = ex.reason ?: @"command failed";
        }
        return nil;
    }
    NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
    if (outOutput) {
        *outOutput = text;
    }
    if (task.terminationStatus != 0) {
        return nil;
    }
    return text;
}

- (NSString *)mountBastionDMG:(NSString *)dmgPath error:(NSError **)outError {
    NSString *output = nil;
    NSString *ok = [self runShellCommand:@"/usr/bin/hdiutil"
                               arguments:@[@"attach", dmgPath, @"-nobrowse", @"-readonly", @"-plist"]
                                  output:&output];
    if (!ok) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:2 userInfo:@{
                NSLocalizedDescriptionKey: output.length > 0 ? output : @"Impossibile montare il DMG"
            }];
        }
        return nil;
    }

    NSData *plistData = [output dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *plist = plistData
        ? [NSPropertyListSerialization propertyListWithData:plistData options:0 format:nil error:nil]
        : nil;
    if (![plist isKindOfClass:[NSDictionary class]]) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:3 userInfo:@{
                NSLocalizedDescriptionKey: @"Risposta mount DMG non valida"
            }];
        }
        return nil;
    }

    NSArray *entities = plist[@"system-entities"];
    if (![entities isKindOfClass:[NSArray class]]) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:4 userInfo:@{
                NSLocalizedDescriptionKey: @"Nessun volume trovato nel DMG"
            }];
        }
        return nil;
    }

    for (id entry in entities) {
        if (![entry isKindOfClass:[NSDictionary class]]) {
            continue;
        }
        NSString *mountPoint = entry[@"mount-point"];
        if ([mountPoint isKindOfClass:[NSString class]] && mountPoint.length > 0 &&
            [[NSFileManager defaultManager] fileExistsAtPath:mountPoint]) {
            return mountPoint;
        }
    }

    if (outError) {
        *outError = [NSError errorWithDomain:@"BastionUpdate" code:5 userInfo:@{
            NSLocalizedDescriptionKey: @"Volume DMG non montato"
        }];
    }
    return nil;
}

- (void)unmountBastionVolume:(NSString *)mountPoint {
    if (mountPoint.length == 0) {
        return;
    }
    [self runShellCommand:@"/usr/bin/hdiutil" arguments:@[@"detach", mountPoint, @"-force"] output:nil];
}

- (NSString *)findBastionAppInDirectory:(NSString *)root {
    if (root.length == 0) {
        return nil;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *preferred = [root stringByAppendingPathComponent:@"RedGalaxy Bastion.app"];
    if ([fm fileExistsAtPath:preferred]) {
        return preferred;
    }

    NSDirectoryEnumerator *enumerator = [fm enumeratorAtPath:root];
    NSString *relative = nil;
    while ((relative = [enumerator nextObject])) {
        if ([relative.pathExtension.lowercaseString isEqualToString:@"app"] &&
            [relative.lastPathComponent.lowercaseString containsString:@"bastion"]) {
            [enumerator skipDescendants];
            return [root stringByAppendingPathComponent:relative];
        }
    }

    enumerator = [fm enumeratorAtPath:root];
    while ((relative = [enumerator nextObject])) {
        if ([relative.pathExtension.lowercaseString isEqualToString:@"app"]) {
            [enumerator skipDescendants];
            return [root stringByAppendingPathComponent:relative];
        }
    }
    return nil;
}

- (BOOL)installBastionAppFromDMG:(NSString *)dmgPath
                   toDestination:(NSString *)destAppPath
                           error:(NSError **)outError {
    NSString *mountPoint = [self mountBastionDMG:dmgPath error:outError];
    if (!mountPoint) {
        return NO;
    }

    NSString *sourceApp = [self findBastionAppInDirectory:mountPoint];
    if (sourceApp.length == 0) {
        [self unmountBastionVolume:mountPoint];
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:6 userInfo:@{
                NSLocalizedDescriptionKey: @"Nel DMG non c'è RedGalaxy Bastion.app"
            }];
        }
        return NO;
    }

    NSString *stagingParent = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"bastion-update-%@", [[NSUUID UUID] UUIDString]]];
    NSError *mkdirError = nil;
    if (![[NSFileManager defaultManager] createDirectoryAtPath:stagingParent
                                   withIntermediateDirectories:YES
                                                    attributes:nil
                                                         error:&mkdirError]) {
        [self unmountBastionVolume:mountPoint];
        if (outError) *outError = mkdirError;
        return NO;
    }

    NSString *stagingApp = [stagingParent stringByAppendingPathComponent:[destAppPath lastPathComponent]];
    NSString *dittoOut = nil;
    NSString *dittoOk = [self runShellCommand:@"/usr/bin/ditto"
                                    arguments:@[sourceApp, stagingApp]
                                       output:&dittoOut];
    [self unmountBastionVolume:mountPoint];
    if (!dittoOk) {
        [[NSFileManager defaultManager] removeItemAtPath:stagingParent error:nil];
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:7 userInfo:@{
                NSLocalizedDescriptionKey: dittoOut.length > 0 ? dittoOut : @"Copia dal DMG non riuscita"
            }];
        }
        return NO;
    }

    NSString *destParent = [destAppPath stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:destParent
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];

    // ditto can replace a running .app bundle; the process keeps old mappings until relaunch.
    NSString *replaceOut = nil;
    NSString *replaceOk = [self runShellCommand:@"/usr/bin/ditto"
                                      arguments:@[stagingApp, destAppPath]
                                         output:&replaceOut];
    [[NSFileManager defaultManager] removeItemAtPath:stagingParent error:nil];
    if (!replaceOk) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:8 userInfo:@{
                NSLocalizedDescriptionKey: replaceOut.length > 0 ? replaceOut : @"Installazione non riuscita"
            }];
        }
        return NO;
    }
    return YES;
}

- (void)relaunchBastionAtPath:(NSString *)appPath {
    if (appPath.length == 0) {
        return;
    }
    NSString *script = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"bastion-relaunch-%d.sh", getpid()]];
    NSString *body = [NSString stringWithFormat:
        @"#!/bin/bash\n"
        @"APP=%@\n"
        @"PID=%d\n"
        @"while kill -0 \"$PID\" 2>/dev/null; do sleep 0.2; done\n"
        @"sleep 0.4\n"
        @"open \"$APP\"\n"
        @"rm -f -- %@"
        @"\n",
        [self shellQuote:appPath],
        getpid(),
        [self shellQuote:script]];
    [body writeToFile:script atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [[NSFileManager defaultManager] setAttributes:@{NSFilePosixPermissions: @0755}
                                     ofItemAtPath:script
                                            error:nil];

    NSTask *helper = [[NSTask alloc] init];
    helper.launchPath = @"/bin/bash";
    helper.arguments = @[script];
    helper.standardOutput = [NSFileHandle fileHandleWithNullDevice];
    helper.standardError = [NSFileHandle fileHandleWithNullDevice];
    @try {
        [helper launch];
    } @catch (NSException *ex) {
        NSLog(@"Bastion relaunch helper failed: %@", ex);
        [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:appPath]];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
    });
}

- (NSString *)shellQuote:(NSString *)value {
    NSString *escaped = [value stringByReplacingOccurrencesOfString:@"'" withString:@"'\"'\"'"];
    return [NSString stringWithFormat:@"'%@'", escaped ?: @""];
}

- (NSString *)bastionUpdateManifestURL {
    NSDictionary *env = [[NSProcessInfo processInfo] environment];
    NSString *fromEnv = env[@"BASTION_UPDATE_MANIFEST_URL"];
    fromEnv = [fromEnv stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (fromEnv.length > 0) {
        return fromEnv;
    }
    return @"https://github.com/RGBastion/RGBastion/releases/latest/download/bastion-latest.json";
}

- (BOOL)isBastionManifestConfigured:(NSString *)url {
    if (url.length == 0) {
        return NO;
    }
    if ([url rangeOfString:@"OWNER/REPO" options:NSCaseInsensitiveSearch].location != NSNotFound) {
        return NO;
    }
    if ([url.lowercaseString containsString:@"placeholder"] ||
        [url.lowercaseString containsString:@"example.com"]) {
        return NO;
    }
    return [url hasPrefix:@"http://"] || [url hasPrefix:@"https://"];
}

- (NSDictionary *)fetchBastionUpdateManifest {
    NSString *urlString = [self bastionUpdateManifestURL];
    if (![self isBastionManifestConfigured:urlString]) {
        return nil;
    }
    NSURL *url = [NSURL URLWithString:urlString];
    if (!url) {
        return nil;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"GET";
    [request setValue:@"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RedGalaxy-Bastion-Updater/1.0"
    forHTTPHeaderField:@"User-Agent"];
    request.timeoutInterval = 20.0;

    __block NSData *payload = nil;
    __block NSError *requestError = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        (void)response;
        payload = data;
        requestError = error;
        dispatch_semaphore_signal(sem);
    }] resume];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    if (requestError || payload.length == 0) {
        NSLog(@"Bastion manifest fetch failed: %@", requestError);
        return nil;
    }
    id json = [NSJSONSerialization JSONObjectWithData:payload options:0 error:nil];
    if (![json isKindOfClass:[NSDictionary class]]) {
        return nil;
    }
    return (NSDictionary *)json;
}

- (BOOL)downloadURL:(NSURL *)url toFile:(NSString *)destPath error:(NSError **)outError {
    if (!url || destPath.length == 0) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:1 userInfo:@{
                NSLocalizedDescriptionKey: @"URL o percorso non validi"
            }];
        }
        return NO;
    }
    NSString *partial = [destPath stringByAppendingString:@".part"];
    [[NSFileManager defaultManager] removeItemAtPath:partial error:nil];

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    [request setValue:@"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RedGalaxy-Bastion-Updater/1.0"
    forHTTPHeaderField:@"User-Agent"];
    request.timeoutInterval = 300.0;

    __block NSData *payload = nil;
    __block NSHTTPURLResponse *httpResp = nil;
    __block NSError *requestError = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        payload = data;
        httpResp = (NSHTTPURLResponse *)response;
        requestError = error;
        dispatch_semaphore_signal(sem);
    }] resume];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    if (requestError) {
        if (outError) *outError = requestError;
        return NO;
    }
    if (httpResp.statusCode < 200 || httpResp.statusCode >= 300 || payload.length == 0) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"BastionUpdate" code:httpResp.statusCode userInfo:@{
                NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Download HTTP %ld", (long)httpResp.statusCode]
            }];
        }
        return NO;
    }
    if (![payload writeToFile:partial options:NSDataWritingAtomic error:outError]) {
        return NO;
    }
    [[NSFileManager defaultManager] removeItemAtPath:destPath error:nil];
    if (![[NSFileManager defaultManager] moveItemAtPath:partial toPath:destPath error:outError]) {
        return NO;
    }
    return YES;
}

- (void)startBastionSelfUpdate {
    if (![self isStoryBundle]) {
        return;
    }

    NSString *localVersion = [self bastionAppVersion];
    NSString *manifestURL = [self bastionUpdateManifestURL];
    if (![self isBastionManifestConfigured:manifestURL]) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = @"Aggiornamento non disponibile";
        alert.informativeText =
            @"Impossibile verificare aggiornamenti Bastion in questo momento. Riprova più tardi o reinstalla.";
        [alert runModal];
        return;
    }

    NSDictionary *manifest = [self fetchBastionUpdateManifest];
    if (!manifest) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = @"Aggiornamento non riuscito";
        alert.informativeText =
            @"Impossibile scaricare l'aggiornamento Bastion. Verifica la connessione e riprova.";
        [alert runModal];
        return;
    }

    NSString *remote = [manifest[@"version"] isKindOfClass:[NSString class]]
        ? [(NSString *)manifest[@"version"] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        : @"";
    if (remote.length == 0) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = @"Aggiornamento non riuscito";
        alert.informativeText = @"Informazioni di aggiornamento incomplete. Riprova più tardi.";
        [alert runModal];
        return;
    }

    if ([self compareVersion:localVersion to:remote] >= 0) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleInformational;
        alert.messageText = @"Già aggiornato";
        alert.informativeText = [NSString stringWithFormat:@"Versione attuale: %@\nRemota: %@", localVersion, remote];
        [alert runModal];
        return;
    }

    NSString *dmg = [manifest[@"dmg"] isKindOfClass:[NSString class]] ? (NSString *)manifest[@"dmg"] : @"";
    NSString *releaseUrl = [manifest[@"releaseUrl"] isKindOfClass:[NSString class]]
        ? (NSString *)manifest[@"releaseUrl"]
        : ([manifest[@"html_url"] isKindOfClass:[NSString class]] ? (NSString *)manifest[@"html_url"] : @"");
    NSString *notes = [self playerSafeBastionNotes:
        [manifest[@"notes"] isKindOfClass:[NSString class]] ? (NSString *)manifest[@"notes"] : @""];

    if (dmg.length == 0) {
        if (releaseUrl.length > 0) {
            [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:releaseUrl]];
            NSAlert *alert = [[NSAlert alloc] init];
            alert.alertStyle = NSAlertStyleInformational;
            alert.messageText = @"Nuova versione disponibile";
            alert.informativeText = [NSString stringWithFormat:
                @"Versione installata: %@\nNuova: %@\n\nApro la pagina di download. Installa la nuova versione e riavvia Bastion.",
                localVersion, remote];
            [alert runModal];
            return;
        }
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = @"Aggiornamento non disponibile";
        alert.informativeText = @"Pacchetto di aggiornamento incompleto. Riprova più tardi.";
        [alert runModal];
        return;
    }

    NSAlert *confirm = [[NSAlert alloc] init];
    confirm.alertStyle = NSAlertStyleInformational;
    confirm.messageText = @"Aggiornamento Bastion disponibile";
    NSMutableString *detail = [NSMutableString stringWithFormat:
        @"Installata: %@\nNuova: %@\n\nScarico e installo automaticamente, poi riavvio Bastion.",
        localVersion, remote];
    if (notes.length > 0) {
        [detail appendFormat:@"\n\n%@", notes];
    }
    confirm.informativeText = detail;
    [confirm addButtonWithTitle:@"Aggiorna ora"];
    [confirm addButtonWithTitle:@"Annulla"];
    if ([confirm runModal] != NSAlertFirstButtonReturn) {
        return;
    }

    NSArray<NSString *> *dirs = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
    NSString *cacheRoot = dirs.count > 0 ? dirs[0] : NSTemporaryDirectory();
    NSString *downloads = [cacheRoot stringByAppendingPathComponent:@"RedGalaxyBastionUpdates"];
    [[NSFileManager defaultManager] createDirectoryAtPath:downloads
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    NSString *fileName = [[NSURL URLWithString:dmg] lastPathComponent];
    if (fileName.length == 0) {
        fileName = [NSString stringWithFormat:@"RedGalaxy-Bastion-%@.dmg", remote];
    }
    NSString *destPath = [downloads stringByAppendingPathComponent:fileName];

    NSError *dlError = nil;
    BOOL ok = [self downloadURL:[NSURL URLWithString:dmg] toFile:destPath error:&dlError];
    if (!ok) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = @"Download Bastion fallito";
        alert.informativeText = dlError.localizedDescription ?: @"Errore sconosciuto";
        [alert runModal];
        return;
    }

    NSString *installPath = [self bastionAppInstallDestination];
    NSError *installError = nil;
    BOOL installed = [self installBastionAppFromDMG:destPath toDestination:installPath error:&installError];
    if (!installed) {
        [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:destPath]];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = @"Installazione automatica non riuscita";
        alert.informativeText = [NSString stringWithFormat:
            @"%@\n\nHo aperto il DMG scaricato. Copia RedGalaxy Bastion.app nella cartella Applicazioni e riavvia.",
            installError.localizedDescription ?: @"Errore sconosciuto"];
        [alert runModal];
        return;
    }

    NSAlert *done = [[NSAlert alloc] init];
    done.alertStyle = NSAlertStyleInformational;
    done.messageText = @"Aggiornamento completato";
    done.informativeText = [NSString stringWithFormat:
        @"Bastion %@ è stato installato in:\n%@\n\nRiavvio l'app ora.",
        remote, installPath];
    [done addButtonWithTitle:@"Riavvia"];
    [done runModal];
    [self relaunchBastionAtPath:installPath];
}

@end

int main(int argc, const char *argv[]) {
    (void)argc;
    (void)argv;
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        RedGalaxyHostApp *delegate = [[RedGalaxyHostApp alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
