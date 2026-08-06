#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

static char g_root[PATH_MAX];
static char g_root_real[PATH_MAX];

static bool dir_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static void trim_last_component(char *path) {
    size_t len = strlen(path);
    while (len > 1 && path[len - 1] == '/') {
        path[--len] = '\0';
    }
    char *slash = strrchr(path, '/');
    if (slash && slash != path) {
        *slash = '\0';
    } else if (slash == path) {
        path[1] = '\0';
    }
}

static bool file_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

static bool try_set_user_web_root(void) {
    const char *env_root = getenv("REDUNIVERSE_WEB_ROOT");
    if (!env_root || !env_root[0]) env_root = getenv("REDGALAXY_WEB_ROOT");
    if (env_root && env_root[0]) {
        snprintf(g_root, sizeof(g_root), "%s", env_root);
        return true;
    }

    const char *home = getenv("HOME");
    if (!home || !home[0]) return false;

    char candidate[PATH_MAX];
    /* Brand-specific App Support only — never cross RG ↔ RU.
     * Compile-time brand is required (see BASTION_BRAND_*). */
#if defined(BASTION_BRAND_REDUNIVERSE)
    const char *support_names[] = {
        "RedUniverse Bastion",
        "RedUniverse",
        "RedUniverse Native",
    };
#elif defined(BASTION_BRAND_REDGALAXY)
    const char *support_names[] = {
        "RedGalaxy Bastion",
        "RedGalaxy Native",
        "RedGalaxy",
    };
#else
#error "Define BASTION_BRAND_REDGALAXY=1 or BASTION_BRAND_REDUNIVERSE=1 at compile time"
#endif
    for (size_t i = 0; i < sizeof(support_names) / sizeof(support_names[0]); i++) {
        snprintf(candidate, sizeof(candidate), "%s/Library/Application Support/%s/web", home, support_names[i]);
        if (!dir_exists(candidate)) continue;

        char index_path[PATH_MAX];
        snprintf(index_path, sizeof(index_path), "%s/index.html", candidate);
        if (!file_exists(index_path)) continue;

        snprintf(g_root, sizeof(g_root), "%s", candidate);
        return true;
    }
    return false;
}

static void die(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fputc('\n', stderr);
    exit(1);
}

static void derive_bundle_web_root(void) {
    uint32_t size = sizeof(g_root);
    if (_NSGetExecutablePath(g_root, &size) != 0) {
        die("Executable path is too long.");
    }

    char resolved[PATH_MAX];
    if (realpath(g_root, resolved) != NULL) {
        snprintf(g_root, sizeof(g_root), "%s", resolved);
    }

    trim_last_component(g_root); /* Contents/MacOS */
    trim_last_component(g_root); /* Contents */
    snprintf(g_root + strlen(g_root), sizeof(g_root) - strlen(g_root), "/Resources/web");
}

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void url_decode_path(const char *src, char *dst, size_t dst_size) {
    size_t di = 0;
    for (size_t si = 0; src[si] && di + 1 < dst_size; si++) {
        if (src[si] == '%' && isxdigit((unsigned char)src[si + 1]) && isxdigit((unsigned char)src[si + 2])) {
            int hi = hex_value(src[si + 1]);
            int lo = hex_value(src[si + 2]);
            dst[di++] = (char)((hi << 4) | lo);
            si += 2;
        } else {
            dst[di++] = src[si];
        }
    }
    dst[di] = '\0';
}

static const char *content_type_for(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (strcmp(dot, ".html") == 0) return "text/html; charset=utf-8";
    if (strcmp(dot, ".js") == 0) return "text/javascript; charset=utf-8";
    if (strcmp(dot, ".css") == 0) return "text/css; charset=utf-8";
    if (strcmp(dot, ".json") == 0 || strcmp(dot, ".map") == 0) return "application/json; charset=utf-8";
    if (strcmp(dot, ".svg") == 0) return "image/svg+xml";
    if (strcmp(dot, ".png") == 0) return "image/png";
    if (strcmp(dot, ".jpg") == 0 || strcmp(dot, ".jpeg") == 0) return "image/jpeg";
    if (strcmp(dot, ".webp") == 0) return "image/webp";
    if (strcmp(dot, ".gif") == 0) return "image/gif";
    if (strcmp(dot, ".woff") == 0) return "font/woff";
    if (strcmp(dot, ".woff2") == 0) return "font/woff2";
    if (strcmp(dot, ".ogg") == 0) return "audio/ogg";
    if (strcmp(dot, ".wav") == 0) return "audio/wav";
    if (strcmp(dot, ".atlas") == 0 || strcmp(dot, ".txt") == 0) return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

static bool send_all(int fd, const void *buf, size_t len) {
    const char *p = (const char *)buf;
    while (len > 0) {
        ssize_t n = send(fd, p, len, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;
        p += n;
        len -= (size_t)n;
    }
    return true;
}

static void send_text_response(int client, int code, const char *label, const char *body) {
    char header[1024];
    size_t body_len = strlen(body);
    int n = snprintf(
        header,
        sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "\r\n",
        code,
        label,
        body_len
    );
    if (n > 0) send_all(client, header, (size_t)n);
    send_all(client, body, body_len);
}

static bool path_is_under_root(const char *resolved) {
    size_t root_len = strlen(g_root_real);
    return strncmp(resolved, g_root_real, root_len) == 0 &&
           (resolved[root_len] == '\0' || resolved[root_len] == '/');
}

static void serve_file(int client, const char *method, const char *url_path) {
    bool head_only = strcmp(method, "HEAD") == 0;
    if (strcmp(method, "GET") != 0 && !head_only) {
        send_text_response(client, 405, "Method Not Allowed", "Method not allowed.\n");
        return;
    }

    char path_only[2048];
    snprintf(path_only, sizeof(path_only), "%s", url_path);
    char *query = strchr(path_only, '?');
    if (query) *query = '\0';
    char *hash = strchr(path_only, '#');
    if (hash) *hash = '\0';

    char decoded[2048];
    url_decode_path(path_only, decoded, sizeof(decoded));

    if (decoded[0] == '\0' || strcmp(decoded, "/") == 0) {
        snprintf(decoded, sizeof(decoded), "/index.html");
    }

    size_t decoded_len = strlen(decoded);
    bool ends_with_parent = decoded_len >= 3 && strcmp(decoded + decoded_len - 3, "/..") == 0;
    if (decoded[0] != '/' || strstr(decoded, "/../") || ends_with_parent) {
        send_text_response(client, 400, "Bad Request", "Bad path.\n");
        return;
    }

    char candidate[PATH_MAX];
    snprintf(candidate, sizeof(candidate), "%s%s", g_root_real, decoded);

    char resolved[PATH_MAX];
    if (realpath(candidate, resolved) == NULL || !path_is_under_root(resolved)) {
        send_text_response(client, 404, "Not Found", "Not found.\n");
        return;
    }

    struct stat st;
    if (stat(resolved, &st) != 0 || !S_ISREG(st.st_mode)) {
        send_text_response(client, 404, "Not Found", "Not found.\n");
        return;
    }

    int file = open(resolved, O_RDONLY);
    if (file < 0) {
        send_text_response(client, 403, "Forbidden", "Cannot open file.\n");
        return;
    }

    const char *ctype = content_type_for(resolved);
    char header[1024];
    int n = snprintf(
        header,
        sizeof(header),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %lld\r\n"
        "Connection: close\r\n"
        "Cache-Control: no-cache\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "\r\n",
        ctype,
        (long long)st.st_size
    );
    if (n > 0) send_all(client, header, (size_t)n);

    if (!head_only) {
        char buf[64 * 1024];
        for (;;) {
            ssize_t r = read(file, buf, sizeof(buf));
            if (r < 0) {
                if (errno == EINTR) continue;
                break;
            }
            if (r == 0) break;
            if (!send_all(client, buf, (size_t)r)) break;
        }
    }

    close(file);
}

static void handle_client(int client) {
    char request[8192];
    ssize_t n = recv(client, request, sizeof(request) - 1, 0);
    if (n <= 0) return;
    request[n] = '\0';

    char method[16] = {0};
    char path[2048] = {0};
    if (sscanf(request, "%15s %2047s", method, path) != 2) {
        send_text_response(client, 400, "Bad Request", "Bad request.\n");
        return;
    }

    serve_file(client, method, path);
}

static int bind_server(int preferred_port, int *actual_port) {
    for (int port = preferred_port; port < preferred_port + 50; port++) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0) return -1;

        int yes = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

        struct sockaddr_in addr;
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons((uint16_t)port);

        if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
            if (listen(fd, 64) == 0) {
                *actual_port = port;
                return fd;
            }
        }

        close(fd);
        if (errno != EADDRINUSE && errno != EACCES) {
            return -1;
        }
    }
    return -1;
}

static void open_browser(int port) {
    char url[128];
    snprintf(url, sizeof(url), "http://127.0.0.1:%d/", port);

    pid_t pid = fork();
    if (pid == 0) {
        execl("/usr/bin/open", "open", url, (char *)NULL);
        _exit(127);
    }
}

static void usage(const char *argv0) {
    fprintf(stderr, "Usage: %s [--no-open] [--port PORT] [WEB_ROOT]\n", argv0);
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);

    bool should_open = true;
    int preferred_port = 8765;
    const char *root_arg = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--no-open") == 0) {
            should_open = false;
        } else if (strcmp(argv[i], "--port") == 0) {
            if (++i >= argc) {
                usage(argv[0]);
                return 2;
            }
            preferred_port = atoi(argv[i]);
            if (preferred_port <= 0 || preferred_port > 65535) {
                die("Invalid port: %s", argv[i]);
            }
        } else if (argv[i][0] == '-') {
            usage(argv[0]);
            return 2;
        } else {
            root_arg = argv[i];
        }
    }

    if (root_arg) {
        snprintf(g_root, sizeof(g_root), "%s", root_arg);
    } else if (!try_set_user_web_root()) {
        derive_bundle_web_root();
    }

    if (realpath(g_root, g_root_real) == NULL) {
        die("Cannot resolve web root: %s", g_root);
    }

    char index_path[PATH_MAX];
    snprintf(index_path, sizeof(index_path), "%s/index.html", g_root_real);
    if (!file_exists(index_path)) {
        die("Missing index.html in web root: %s", g_root_real);
    }

    int port = 0;
    int server = bind_server(preferred_port, &port);
    if (server < 0) {
        die("Cannot bind local server near port %d: %s", preferred_port, strerror(errno));
    }

    printf("Bastion native server is serving %s\n", g_root_real);
    printf("Open http://127.0.0.1:%d/\n", port);
    fflush(stdout);

    if (should_open) {
        open_browser(port);
    }

    for (;;) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int client = accept(server, (struct sockaddr *)&client_addr, &client_len);
        if (client < 0) {
            if (errno == EINTR) continue;
            perror("accept");
            break;
        }
        handle_client(client);
        close(client);
    }

    close(server);
    return 0;
}
