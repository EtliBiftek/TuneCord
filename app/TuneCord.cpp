#define NOMINMAX
#define WIN32_LEAN_AND_MEAN

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <uxtheme.h>
#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <filesystem>
#include <iomanip>
#include <mutex>
#include <optional>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "resource.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "uxtheme.lib")

namespace {

constexpr wchar_t kWindowClass[] = L"TuneCord.MainWindow";
constexpr wchar_t kWindowTitle[] = L"TuneCord";
constexpr wchar_t kRunKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunValue[] = L"TuneCord";
constexpr UINT kTrayMessage = WM_APP + 1;
constexpr UINT kRefreshMessage = WM_APP + 2;
constexpr UINT_PTR kPresenceTimer = 1;
constexpr unsigned short kBridgePort = 37645;

struct Playlist {
    std::string id;
    std::string title;
};

struct Track {
    std::string title;
    std::string artist;
    std::string videoId;
    std::string playlistId;
    std::string url;
    std::string thumbnail;
    std::string source;
    double duration = 0;
    double currentTime = 0;
    bool playing = false;
    std::chrono::steady_clock::time_point receivedAt{};
};

struct Config {
    bool enabled = true;
    bool selectedOnly = false;
    std::string discordAppId;
    std::string bridgeToken;
    std::set<std::string> selectedPlaylistIds;
    std::vector<Playlist> playlists;
};

HINSTANCE g_instance = nullptr;
HWND g_window = nullptr;
HWND g_playlistView = nullptr;
HFONT g_font = nullptr;
HFONT g_titleFont = nullptr;
HFONT g_smallFont = nullptr;
HBRUSH g_backgroundBrush = nullptr;
HBRUSH g_cardBrush = nullptr;
HBRUSH g_fieldBrush = nullptr;
NOTIFYICONDATAW g_tray{};
std::mutex g_stateMutex;
Config g_config;
Track g_track;
std::atomic<bool> g_running{true};
std::atomic<SOCKET> g_listenSocket{INVALID_SOCKET};
std::atomic<long long> g_extensionSeen{0};
std::atomic<bool> g_discordConnected{false};
bool g_fillingPlaylists = false;
bool g_exitRequested = false;

constexpr COLORREF kBackground = RGB(12, 12, 15);
constexpr COLORREF kCard = RGB(24, 24, 30);
constexpr COLORREF kField = RGB(31, 31, 39);
constexpr COLORREF kText = RGB(242, 242, 247);
constexpr COLORREF kMutedText = RGB(165, 165, 178);
constexpr COLORREF kAccent = RGB(151, 94, 255);
constexpr COLORREF kAccentHover = RGB(176, 130, 255);

void DrawRoundedRect(HDC dc, const RECT& rect, COLORREF fill, COLORREF border, int radius = 14) {
    HBRUSH brush = CreateSolidBrush(fill);
    HPEN pen = CreatePen(PS_SOLID, 1, border);
    HGDIOBJ oldBrush = SelectObject(dc, brush);
    HGDIOBJ oldPen = SelectObject(dc, pen);
    RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
    SelectObject(dc, oldPen);
    SelectObject(dc, oldBrush);
    DeleteObject(pen);
    DeleteObject(brush);
}

void EnableModernWindowFrame(HWND hwnd) {
    const BOOL dark = TRUE;
    const DWM_WINDOW_CORNER_PREFERENCE corners = DWMWCP_ROUND;
    const COLORREF border = kBackground;
    DwmSetWindowAttribute(hwnd, 20, &dark, sizeof(dark));
    DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
    DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &border, sizeof(border));
}

std::wstring Utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (count <= 0) {
        count = MultiByteToWideChar(CP_ACP, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
        std::wstring fallback(count, L'\0');
        if (count) MultiByteToWideChar(CP_ACP, 0, value.data(), static_cast<int>(value.size()), fallback.data(), count);
        return fallback;
    }
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), count);
    return result;
}

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    int count = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), count, nullptr, nullptr);
    return result;
}

std::string JsonEscape(const std::string& value) {
    std::ostringstream out;
    for (unsigned char c : value) {
        switch (c) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (c < 0x20) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c) << std::dec;
                else out << static_cast<char>(c);
        }
    }
    return out.str();
}

void AppendUtf8(std::string& target, unsigned codepoint) {
    if (codepoint <= 0x7F) target.push_back(static_cast<char>(codepoint));
    else if (codepoint <= 0x7FF) {
        target.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
        target.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    } else {
        target.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
        target.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
        target.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    }
}

std::optional<size_t> FindJsonValue(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return std::nullopt;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return std::nullopt;
    do { ++pos; } while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos])));
    return pos;
}

std::optional<std::string> ParseJsonStringAt(const std::string& json, size_t& pos) {
    if (pos >= json.size() || json[pos] != '"') return std::nullopt;
    ++pos;
    std::string result;
    while (pos < json.size()) {
        char c = json[pos++];
        if (c == '"') return result;
        if (c != '\\') { result.push_back(c); continue; }
        if (pos >= json.size()) break;
        char escaped = json[pos++];
        switch (escaped) {
            case '"': result.push_back('"'); break;
            case '\\': result.push_back('\\'); break;
            case '/': result.push_back('/'); break;
            case 'b': result.push_back('\b'); break;
            case 'f': result.push_back('\f'); break;
            case 'n': result.push_back('\n'); break;
            case 'r': result.push_back('\r'); break;
            case 't': result.push_back('\t'); break;
            case 'u': {
                if (pos + 4 > json.size()) return std::nullopt;
                unsigned cp = 0;
                for (int i = 0; i < 4; ++i) {
                    char h = json[pos++];
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp |= h - '0';
                    else if (h >= 'a' && h <= 'f') cp |= h - 'a' + 10;
                    else if (h >= 'A' && h <= 'F') cp |= h - 'A' + 10;
                    else return std::nullopt;
                }
                AppendUtf8(result, cp);
                break;
            }
            default: result.push_back(escaped); break;
        }
    }
    return std::nullopt;
}

std::optional<std::string> JsonString(const std::string& json, const std::string& key) {
    auto pos = FindJsonValue(json, key);
    if (!pos) return std::nullopt;
    return ParseJsonStringAt(json, *pos);
}

std::optional<bool> JsonBool(const std::string& json, const std::string& key) {
    auto pos = FindJsonValue(json, key);
    if (!pos) return std::nullopt;
    if (json.compare(*pos, 4, "true") == 0) return true;
    if (json.compare(*pos, 5, "false") == 0) return false;
    return std::nullopt;
}

std::optional<double> JsonNumber(const std::string& json, const std::string& key) {
    auto pos = FindJsonValue(json, key);
    if (!pos) return std::nullopt;
    char* end = nullptr;
    double value = std::strtod(json.c_str() + *pos, &end);
    if (end == json.c_str() + *pos) return std::nullopt;
    return value;
}

std::vector<std::string> JsonStringArray(const std::string& json, const std::string& key) {
    std::vector<std::string> result;
    auto posValue = FindJsonValue(json, key);
    if (!posValue) return result;
    size_t pos = *posValue;
    if (pos >= json.size() || json[pos] != '[') return result;
    ++pos;
    while (pos < json.size()) {
        while (pos < json.size() && (std::isspace(static_cast<unsigned char>(json[pos])) || json[pos] == ',')) ++pos;
        if (pos >= json.size() || json[pos] == ']') break;
        auto item = ParseJsonStringAt(json, pos);
        if (!item) break;
        result.push_back(*item);
    }
    return result;
}

std::vector<Playlist> JsonPlaylists(const std::string& json) {
    std::vector<Playlist> result;
    auto valuePos = FindJsonValue(json, "items");
    if (!valuePos || *valuePos >= json.size() || json[*valuePos] != '[') return result;
    size_t pos = *valuePos + 1;
    bool inString = false;
    bool escaped = false;
    int depth = 0;
    size_t objectStart = std::string::npos;
    for (; pos < json.size(); ++pos) {
        char c = json[pos];
        if (inString) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') inString = false;
            continue;
        }
        if (c == '"') { inString = true; continue; }
        if (c == '{') {
            if (depth++ == 0) objectStart = pos;
        } else if (c == '}' && depth > 0) {
            if (--depth == 0 && objectStart != std::string::npos) {
                std::string object = json.substr(objectStart, pos - objectStart + 1);
                auto id = JsonString(object, "id");
                auto title = JsonString(object, "title");
                if (id && !id->empty()) result.push_back({*id, title.value_or(*id)});
                objectStart = std::string::npos;
            }
        } else if (c == ']' && depth == 0) break;
    }
    return result;
}

std::wstring ConfigDirectory() {
    wchar_t buffer[MAX_PATH]{};
    DWORD count = GetEnvironmentVariableW(L"LOCALAPPDATA", buffer, MAX_PATH);
    std::wstring path = (count > 0 && count < MAX_PATH) ? buffer : L".";
    path += L"\\TuneCord";
    CreateDirectoryW(path.c_str(), nullptr);
    return path;
}

std::wstring ConfigPath() { return ConfigDirectory() + L"\\config.json"; }

std::string GenerateToken() {
    unsigned char bytes[24]{};
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        std::random_device random;
        for (auto& byte : bytes) byte = static_cast<unsigned char>(random());
    }
    static constexpr char hex[] = "0123456789abcdef";
    std::string token;
    token.reserve(sizeof(bytes) * 2);
    for (unsigned char byte : bytes) {
        token.push_back(hex[byte >> 4]);
        token.push_back(hex[byte & 0x0F]);
    }
    return token;
}

void SaveConfigLocked() {
    std::ofstream out(std::filesystem::path(ConfigPath()), std::ios::binary | std::ios::trunc);
    if (!out) return;
    out << "{\n"
        << "  \"enabled\": " << (g_config.enabled ? "true" : "false") << ",\n"
        << "  \"selectedOnly\": " << (g_config.selectedOnly ? "true" : "false") << ",\n"
        << "  \"discordAppId\": \"" << JsonEscape(g_config.discordAppId) << "\",\n"
        << "  \"bridgeToken\": \"" << JsonEscape(g_config.bridgeToken) << "\",\n"
        << "  \"selectedPlaylistIds\": [";
    bool first = true;
    for (const auto& id : g_config.selectedPlaylistIds) {
        if (!first) out << ',';
        out << "\"" << JsonEscape(id) << "\"";
        first = false;
    }
    out << "],\n  \"items\": [";
    first = true;
    for (const auto& playlist : g_config.playlists) {
        if (!first) out << ',';
        out << "{\"id\":\"" << JsonEscape(playlist.id) << "\",\"title\":\"" << JsonEscape(playlist.title) << "\"}";
        first = false;
    }
    out << "]\n}\n";
}

void SaveConfig() {
    std::lock_guard lock(g_stateMutex);
    SaveConfigLocked();
}

void LoadConfig() {
    std::ifstream in(std::filesystem::path(ConfigPath()), std::ios::binary);
    if (in) {
        std::ostringstream content;
        content << in.rdbuf();
        std::string json = content.str();
        if (auto enabled = JsonBool(json, "enabled")) g_config.enabled = *enabled;
        if (auto selected = JsonBool(json, "selectedOnly")) g_config.selectedOnly = *selected;
        if (auto appId = JsonString(json, "discordAppId")) g_config.discordAppId = *appId;
        if (auto token = JsonString(json, "bridgeToken")) g_config.bridgeToken = *token;
        for (const auto& id : JsonStringArray(json, "selectedPlaylistIds")) g_config.selectedPlaylistIds.insert(id);
        g_config.playlists = JsonPlaylists(json);
    }
    if (g_config.bridgeToken.size() < 32) g_config.bridgeToken = GenerateToken();
    SaveConfigLocked();
}

bool StartupEnabled() {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) return false;
    LSTATUS result = RegQueryValueExW(key, kRunValue, nullptr, nullptr, nullptr, nullptr);
    RegCloseKey(key);
    return result == ERROR_SUCCESS;
}

bool SetStartupEnabled(bool enabled) {
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRunKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
    LSTATUS result;
    if (enabled) {
        wchar_t exe[MAX_PATH]{};
        GetModuleFileNameW(nullptr, exe, MAX_PATH);
        std::wstring command = L"\"" + std::wstring(exe) + L"\" --tray";
        result = RegSetValueExW(key, kRunValue, 0, REG_SZ, reinterpret_cast<const BYTE*>(command.c_str()), static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
    } else {
        result = RegDeleteValueW(key, kRunValue);
        if (result == ERROR_FILE_NOT_FOUND) result = ERROR_SUCCESS;
    }
    RegCloseKey(key);
    return result == ERROR_SUCCESS;
}

std::string LimitUtf8(std::string value, size_t maxBytes = 120) {
    if (value.size() <= maxBytes) return value;
    size_t end = maxBytes - 3;
    while (end > 0 && (static_cast<unsigned char>(value[end]) & 0xC0) == 0x80) --end;
    value.resize(end);
    value += "...";
    return value;
}

class DiscordIpc {
public:
    ~DiscordIpc() { Disconnect(); }

    bool Connected() const { return pipe_ != INVALID_HANDLE_VALUE; }

    bool EnsureConnected(const std::string& appId) {
        if (appId.empty()) { Disconnect(); return false; }
        if (Connected() && appId_ == appId) {
            if (Drain()) return true;
            Disconnect();
        }
        Disconnect();

        for (int index = 0; index < 10; ++index) {
            std::wstring path = L"\\\\?\\pipe\\discord-ipc-" + std::to_wstring(index);
            pipe_ = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
            if (pipe_ != INVALID_HANDLE_VALUE) break;
        }
        if (!Connected()) return false;
        appId_ = appId;
        std::string handshake = "{\"v\":1,\"client_id\":\"" + JsonEscape(appId) + "\"}";
        if (!WriteFrame(0, handshake)) { Disconnect(); return false; }
        return true;
    }

    bool SetActivity(const Track& track) {
        if (!Connected()) return false;
        if (!Drain()) { Disconnect(); return false; }
        const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        const double ageSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - track.receivedAt).count();
        const double position = std::max(0.0, track.currentTime + (track.playing ? ageSeconds : 0.0));
        long long start = static_cast<long long>(now - position);
        long long end = start + static_cast<long long>(std::max(0.0, track.duration));

        std::ostringstream activity;
        activity << "{\"cmd\":\"SET_ACTIVITY\",\"args\":{\"pid\":" << GetCurrentProcessId() << ",\"activity\":{";
        activity << "\"type\":2,";
        activity << "\"details\":\"" << JsonEscape(LimitUtf8(track.title.empty() ? "Bilinmeyen parça" : track.title)) << "\",";
        activity << "\"state\":\"" << JsonEscape(LimitUtf8(track.artist.empty() ? track.source : track.artist)) << "\",";
        if (track.duration > 1) activity << "\"timestamps\":{\"start\":" << start << ",\"end\":" << end << "},";
        if (track.url.rfind("https://", 0) == 0) {
            activity << "\"buttons\":[{\"label\":\"YouTube'da Aç\",\"url\":\"" << JsonEscape(track.url) << "\"}],";
        }
        activity << "\"instance\":false}},\"nonce\":\"" << ++nonce_ << "\"}";
        if (!WriteFrame(1, activity.str())) { Disconnect(); return false; }
        return true;
    }

    void ClearActivity() {
        if (!Connected()) return;
        if (!Drain()) { Disconnect(); return; }
        std::ostringstream payload;
        payload << "{\"cmd\":\"SET_ACTIVITY\",\"args\":{\"pid\":" << GetCurrentProcessId()
                << ",\"activity\":null},\"nonce\":\"" << ++nonce_ << "\"}";
        if (!WriteFrame(1, payload.str())) Disconnect();
    }

private:
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    std::string appId_;
    unsigned long long nonce_ = 0;

    void Disconnect() {
        if (pipe_ != INVALID_HANDLE_VALUE) CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
        appId_.clear();
    }

    bool WriteFrame(uint32_t op, const std::string& payload) {
        struct Header { uint32_t op; uint32_t length; } header{op, static_cast<uint32_t>(payload.size())};
        DWORD written = 0;
        if (!WriteFile(pipe_, &header, sizeof(header), &written, nullptr) || written != sizeof(header)) return false;
        return WriteFile(pipe_, payload.data(), static_cast<DWORD>(payload.size()), &written, nullptr) && written == payload.size();
    }

    bool Drain() {
        if (!Connected()) return false;
        DWORD available = 0;
        while (true) {
            if (!PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) return false;
            if (!available) return true;
            char buffer[4096];
            DWORD read = 0;
            DWORD amount = std::min<DWORD>(available, sizeof(buffer));
            if (!ReadFile(pipe_, buffer, amount, &read, nullptr) || !read) return false;
        }
    }
};

DiscordIpc g_discord;
bool g_presenceWasActive = false;
std::string g_lastPresenceKey;

bool IsTrackAllowed(const Config& config, const Track& track) {
    if (!config.enabled || !track.playing || track.title.empty()) return false;
    if (!config.selectedOnly) return true;
    return !track.playlistId.empty() && config.selectedPlaylistIds.contains(track.playlistId);
}

void ProcessPresence() {
    Config config;
    Track track;
    {
        std::lock_guard lock(g_stateMutex);
        if (g_track.playing && std::chrono::steady_clock::now() - g_track.receivedAt > std::chrono::seconds(90)) {
            g_track.playing = false;
        }
        config = g_config;
        track = g_track;
    }
    bool allowed = IsTrackAllowed(config, track) && !config.discordAppId.empty();
    const bool wasConnected = g_discord.Connected();
    const auto epochNow = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    const double ageSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - track.receivedAt).count();
    const double adjustedPosition = std::max(0.0, track.currentTime + (track.playing ? ageSeconds : 0.0));
    const long long estimatedStart = static_cast<long long>((epochNow - adjustedPosition) / 5.0) * 5;
    const std::string presenceKey = config.discordAppId + "\n" + track.videoId + "\n" + track.title + "\n" + track.artist + "\n" + track.playlistId + "\n" + std::to_string(estimatedStart);
    if (allowed && g_discord.EnsureConnected(config.discordAppId)) {
        if (!wasConnected || !g_presenceWasActive || presenceKey != g_lastPresenceKey) {
            g_presenceWasActive = g_discord.SetActivity(track);
            if (g_presenceWasActive) g_lastPresenceKey = presenceKey;
        }
    } else {
        if (g_presenceWasActive) g_discord.ClearActivity();
        g_presenceWasActive = false;
        g_lastPresenceKey.clear();
    }
    g_discordConnected = g_discord.Connected();
}

std::string StatusJson() {
    std::lock_guard lock(g_stateMutex);
    std::ostringstream out;
    out << "{\"ok\":true,\"enabled\":" << (g_config.enabled ? "true" : "false")
        << ",\"selectedOnly\":" << (g_config.selectedOnly ? "true" : "false")
        << ",\"discordConnected\":" << (g_discordConnected.load() ? "true" : "false")
        << ",\"discordAppId\":\"" << JsonEscape(g_config.discordAppId) << "\""
        << ",\"selectedPlaylistIds\":[";
    bool first = true;
    for (const auto& id : g_config.selectedPlaylistIds) {
        if (!first) out << ',';
        out << "\"" << JsonEscape(id) << "\"";
        first = false;
    }
    out << "],\"playlists\":[";
    first = true;
    for (const auto& playlist : g_config.playlists) {
        if (!first) out << ',';
        out << "{\"id\":\"" << JsonEscape(playlist.id) << "\",\"title\":\"" << JsonEscape(playlist.title) << "\"}";
        first = false;
    }
    out << "],\"track\":{\"title\":\"" << JsonEscape(g_track.title)
        << "\",\"artist\":\"" << JsonEscape(g_track.artist)
        << "\",\"source\":\"" << JsonEscape(g_track.source)
        << "\",\"playlistId\":\"" << JsonEscape(g_track.playlistId)
        << "\",\"playing\":" << (g_track.playing ? "true" : "false") << "}}";
    return out.str();
}

struct HttpRequest {
    std::string method;
    std::string path;
    std::unordered_map<std::string, std::string> headers;
    std::string body;
};

std::string Lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

std::string Trim(std::string value) {
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) value.erase(value.begin());
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) value.pop_back();
    return value;
}

std::optional<HttpRequest> ReadHttpRequest(SOCKET client) {
    std::string raw;
    raw.reserve(8192);
    char buffer[4096];
    size_t headerEnd = std::string::npos;
    size_t contentLength = 0;
    while (raw.size() < 1024 * 1024) {
        int count = recv(client, buffer, sizeof(buffer), 0);
        if (count <= 0) return std::nullopt;
        raw.append(buffer, count);
        if (headerEnd == std::string::npos) {
            headerEnd = raw.find("\r\n\r\n");
            if (headerEnd != std::string::npos) {
                std::string headers = Lower(raw.substr(0, headerEnd));
                size_t pos = headers.find("content-length:");
                if (pos != std::string::npos) contentLength = std::strtoul(headers.c_str() + pos + 15, nullptr, 10);
                if (contentLength > 1024 * 1024) return std::nullopt;
            }
        }
        if (headerEnd != std::string::npos && raw.size() >= headerEnd + 4 + contentLength) break;
    }
    if (headerEnd == std::string::npos) return std::nullopt;

    HttpRequest request;
    std::istringstream stream(raw.substr(0, headerEnd));
    std::string line;
    if (!std::getline(stream, line)) return std::nullopt;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    std::istringstream first(line);
    first >> request.method >> request.path;
    if (request.method.empty() || request.path.empty()) return std::nullopt;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        request.headers[Lower(Trim(line.substr(0, colon)))] = Trim(line.substr(colon + 1));
    }
    request.body = raw.substr(headerEnd + 4, contentLength);
    return request;
}

void SendHttp(SOCKET client, int code, const std::string& body) {
    const char* reason = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : code == 401 ? "Unauthorized" : "Not Found";
    std::ostringstream response;
    response << "HTTP/1.1 " << code << ' ' << reason << "\r\n"
             << "Content-Type: application/json; charset=utf-8\r\n"
             << "Access-Control-Allow-Origin: *\r\n"
             << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
             << "Access-Control-Allow-Headers: Content-Type, X-TuneCord-Token\r\n"
             << "Access-Control-Allow-Private-Network: true\r\n"
             << "Cache-Control: no-store\r\n"
             << "Connection: close\r\n"
             << "Content-Length: " << body.size() << "\r\n\r\n" << body;
    std::string data = response.str();
    size_t sent = 0;
    while (sent < data.size()) {
        int count = send(client, data.data() + sent, static_cast<int>(data.size() - sent), 0);
        if (count <= 0) break;
        sent += static_cast<size_t>(count);
    }
}

bool Authorized(const HttpRequest& request) {
    auto header = request.headers.find("x-tunecord-token");
    if (header == request.headers.end()) return false;
    std::lock_guard lock(g_stateMutex);
    return header->second == g_config.bridgeToken;
}

bool IsExtensionOrigin(const HttpRequest& request) {
    auto origin = request.headers.find("origin");
    return origin != request.headers.end() && origin->second.rfind("chrome-extension://", 0) == 0;
}

void MarkExtensionSeen() {
    g_extensionSeen = static_cast<long long>(std::time(nullptr));
    if (g_window) PostMessageW(g_window, kRefreshMessage, 0, 0);
}

void HandleHttpClient(SOCKET client) {
    auto request = ReadHttpRequest(client);
    if (!request) return;
    if (request->method == "OPTIONS") { SendHttp(client, 204, ""); return; }

    if (request->method == "GET" && request->path == "/api/pair") {
        if (!IsExtensionOrigin(*request)) { SendHttp(client, 401, "{\"ok\":false}"); return; }
        std::lock_guard lock(g_stateMutex);
        SendHttp(client, 200, "{\"ok\":true,\"token\":\"" + JsonEscape(g_config.bridgeToken) + "\"}");
        return;
    }
    if (!Authorized(*request)) { SendHttp(client, 401, "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
    MarkExtensionSeen();

    if (request->method == "GET" && request->path == "/api/status") {
        SendHttp(client, 200, StatusJson());
        return;
    }
    if (request->method == "POST" && request->path == "/api/track") {
        Track track;
        track.title = JsonString(request->body, "title").value_or("");
        track.artist = JsonString(request->body, "artist").value_or("");
        track.videoId = JsonString(request->body, "videoId").value_or("");
        track.playlistId = JsonString(request->body, "playlistId").value_or("");
        track.url = JsonString(request->body, "url").value_or("");
        track.thumbnail = JsonString(request->body, "thumbnail").value_or("");
        track.source = JsonString(request->body, "source").value_or("YouTube");
        track.duration = JsonNumber(request->body, "duration").value_or(0);
        track.currentTime = JsonNumber(request->body, "currentTime").value_or(0);
        track.playing = JsonBool(request->body, "playing").value_or(false);
        track.receivedAt = std::chrono::steady_clock::now();
        {
            std::lock_guard lock(g_stateMutex);
            g_track = std::move(track);
        }
        if (g_window) PostMessageW(g_window, kRefreshMessage, 0, 0);
        SendHttp(client, 200, StatusJson());
        return;
    }
    if (request->method == "POST" && request->path == "/api/stop") {
        {
            std::lock_guard lock(g_stateMutex);
            g_track.playing = false;
            g_track.receivedAt = std::chrono::steady_clock::now();
        }
        if (g_window) PostMessageW(g_window, kRefreshMessage, 0, 0);
        SendHttp(client, 200, StatusJson());
        return;
    }
    if (request->method == "POST" && request->path == "/api/playlists") {
        auto playlists = JsonPlaylists(request->body);
        {
            std::lock_guard lock(g_stateMutex);
            g_config.playlists = std::move(playlists);
            SaveConfigLocked();
        }
        if (g_window) PostMessageW(g_window, kRefreshMessage, 1, 0);
        SendHttp(client, 200, StatusJson());
        return;
    }
    if (request->method == "POST" && request->path == "/api/control") {
        {
            std::lock_guard lock(g_stateMutex);
            if (auto value = JsonBool(request->body, "enabled")) g_config.enabled = *value;
            if (auto value = JsonBool(request->body, "selectedOnly")) g_config.selectedOnly = *value;
            if (auto value = JsonString(request->body, "discordAppId")) g_config.discordAppId = *value;
            if (request->body.find("\"selectedPlaylistIds\"") != std::string::npos) {
                g_config.selectedPlaylistIds.clear();
                for (const auto& id : JsonStringArray(request->body, "selectedPlaylistIds")) g_config.selectedPlaylistIds.insert(id);
            }
            SaveConfigLocked();
        }
        if (g_window) PostMessageW(g_window, kRefreshMessage, 1, 0);
        SendHttp(client, 200, StatusJson());
        return;
    }
    SendHttp(client, 404, "{\"ok\":false,\"error\":\"not_found\"}");
}

void BridgeServer() {
    WSADATA data{};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return;
    SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == INVALID_SOCKET) { WSACleanup(); return; }
    g_listenSocket = server;
    BOOL exclusive = TRUE;
    setsockopt(server, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof(exclusive));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(kBridgePort);
    InetPtonW(AF_INET, L"127.0.0.1", &address.sin_addr);
    if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR || listen(server, 8) == SOCKET_ERROR) {
        closesocket(server);
        g_listenSocket = INVALID_SOCKET;
        WSACleanup();
        return;
    }
    while (g_running) {
        SOCKET client = accept(server, nullptr, nullptr);
        if (client == INVALID_SOCKET) break;
        DWORD timeout = 3000;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
        HandleHttpClient(client);
        shutdown(client, SD_BOTH);
        closesocket(client);
    }
    if (g_listenSocket.exchange(INVALID_SOCKET) != INVALID_SOCKET) closesocket(server);
    WSACleanup();
}

void ApplyFont(HWND control) { SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(g_font), TRUE); }

bool IsChoiceControl(int id) {
    return id == IDC_ENABLED || id == IDC_STARTUP || id == IDC_ALL_TRACKS || id == IDC_SELECTED_ONLY;
}

void DrawOwnerButton(const DRAWITEMSTRUCT* item) {
    const int id = static_cast<int>(item->CtlID);
    const bool selected = (item->itemState & ODS_SELECTED) != 0;
    const bool checked = SendMessageW(item->hwndItem, BM_GETCHECK, 0, 0) == BST_CHECKED;
    const RECT& r = item->rcItem;
    HDC dc = item->hDC;
    SetBkMode(dc, TRANSPARENT);

    if (IsChoiceControl(id)) {
        RECT mark{r.left, r.top + 3, r.left + 20, r.top + 23};
        const bool radio = id == IDC_ALL_TRACKS || id == IDC_SELECTED_ONLY;
        DrawRoundedRect(dc, mark, checked ? kAccent : kField, checked ? kAccent : RGB(66, 66, 79), radio ? 20 : 6);
        if (checked && !radio) {
            HPEN pen = CreatePen(PS_SOLID, 2, RGB(255, 255, 255));
            HGDIOBJ old = SelectObject(dc, pen);
            MoveToEx(dc, mark.left + 5, mark.top + 10, nullptr);
            LineTo(dc, mark.left + 9, mark.top + 14);
            LineTo(dc, mark.left + 16, mark.top + 6);
            SelectObject(dc, old);
            DeleteObject(pen);
        } else if (checked) {
            HBRUSH dot = CreateSolidBrush(RGB(255, 255, 255));
            HGDIOBJ old = SelectObject(dc, dot);
            Ellipse(dc, mark.left + 6, mark.top + 6, mark.right - 6, mark.bottom - 6);
            SelectObject(dc, old);
            DeleteObject(dot);
        }
        SetTextColor(dc, kText);
        SelectObject(dc, g_font);
        RECT text{r.left + 30, r.top, r.right, r.bottom};
        wchar_t label[256]{};
        GetWindowTextW(item->hwndItem, label, 256);
        DrawTextW(dc, label, -1, &text, DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        return;
    }

    const bool primary = id == IDC_SAVE;
    const COLORREF fill = primary ? (selected ? kAccentHover : kAccent) : (selected ? RGB(54, 54, 66) : kField);
    const COLORREF border = primary ? fill : RGB(69, 69, 82);
    DrawRoundedRect(dc, r, fill, border, 12);
    SetTextColor(dc, kText);
    SelectObject(dc, g_font);
    wchar_t label[256]{};
    GetWindowTextW(item->hwndItem, label, 256);
    RECT text = r;
    DrawTextW(dc, label, -1, &text, DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_END_ELLIPSIS);
}

void PaintBackground(HWND hwnd) {
    PAINTSTRUCT ps{};
    HDC dc = BeginPaint(hwnd, &ps);
    RECT client{};
    GetClientRect(hwnd, &client);
    FillRect(dc, &client, g_backgroundBrush);
    RECT topCard{16, 12, client.right - 16, 116};
    RECT settingsCard{16, 128, client.right - 16, 286};
    RECT playlistCard{16, 298, client.right - 16, client.bottom - 16};
    DrawRoundedRect(dc, topCard, kCard, RGB(42, 42, 51), 18);
    DrawRoundedRect(dc, settingsCard, kCard, RGB(42, 42, 51), 18);
    DrawRoundedRect(dc, playlistCard, kCard, RGB(42, 42, 51), 18);
    EndPaint(hwnd, &ps);
}

void SetButtonCheck(HWND control, UINT state) { SendMessageW(control, BM_SETCHECK, state, 0); }
UINT GetButtonCheck(HWND control) { return static_cast<UINT>(SendMessageW(control, BM_GETCHECK, 0, 0)); }

HWND AddControl(const wchar_t* cls, const wchar_t* text, DWORD style, int x, int y, int w, int h, int id) {
    HWND control = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, x, y, w, h, g_window,
                                   reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), g_instance, nullptr);
    ApplyFont(control);
    return control;
}

std::wstring GetControlText(int id) {
    HWND control = GetDlgItem(g_window, id);
    int length = GetWindowTextLengthW(control);
    std::wstring value(length + 1, L'\0');
    GetWindowTextW(control, value.data(), length + 1);
    value.resize(length);
    return value;
}

void FillPlaylists() {
    if (!g_playlistView) return;
    g_fillingPlaylists = true;
    ListView_DeleteAllItems(g_playlistView);
    Config config;
    {
        std::lock_guard lock(g_stateMutex);
        config = g_config;
    }
    int index = 0;
    for (const auto& playlist : config.playlists) {
        std::wstring title = Utf8ToWide(playlist.title);
        std::wstring id = Utf8ToWide(playlist.id);
        LVITEMW item{};
        item.mask = LVIF_TEXT;
        item.iItem = index;
        item.pszText = title.data();
        ListView_InsertItem(g_playlistView, &item);
        ListView_SetItemText(g_playlistView, index, 1, id.data());
        ListView_SetCheckState(g_playlistView, index, config.selectedPlaylistIds.contains(playlist.id));
        ++index;
    }
    g_fillingPlaylists = false;
}

void RefreshUi(bool refillPlaylists = false) {
    Config config;
    Track track;
    {
        std::lock_guard lock(g_stateMutex);
        config = g_config;
        track = g_track;
    }
    SetButtonCheck(GetDlgItem(g_window, IDC_ENABLED), config.enabled ? BST_CHECKED : BST_UNCHECKED);
    SetButtonCheck(GetDlgItem(g_window, IDC_STARTUP), StartupEnabled() ? BST_CHECKED : BST_UNCHECKED);
    SetButtonCheck(GetDlgItem(g_window, IDC_ALL_TRACKS), config.selectedOnly ? BST_UNCHECKED : BST_CHECKED);
    SetButtonCheck(GetDlgItem(g_window, IDC_SELECTED_ONLY), config.selectedOnly ? BST_CHECKED : BST_UNCHECKED);
    SetWindowTextW(GetDlgItem(g_window, IDC_DISCORD_ID), Utf8ToWide(config.discordAppId).c_str());

    const long long now = static_cast<long long>(std::time(nullptr));
    const bool extensionConnected = now - g_extensionSeen.load() < 35;
    std::wstring status = L"Eklenti: ";
    status += extensionConnected ? L"bağlı" : L"bekleniyor";
    status += L"    Discord: ";
    status += g_discordConnected.load() ? L"bağlı" : L"bekleniyor";
    SetWindowTextW(GetDlgItem(g_window, IDC_CONNECTION_STATUS), status.c_str());

    std::wstring nowPlaying = L"Şu an: ";
    if (track.playing && !track.title.empty()) {
        nowPlaying += Utf8ToWide(track.title);
        if (!track.artist.empty()) nowPlaying += L" — " + Utf8ToWide(track.artist);
    } else nowPlaying += L"bir şey çalmıyor";
    SetWindowTextW(GetDlgItem(g_window, IDC_NOW_PLAYING), nowPlaying.c_str());
    if (refillPlaylists) FillPlaylists();
}

void SaveUiSettings() {
    std::string appId = WideToUtf8(GetControlText(IDC_DISCORD_ID));
    appId.erase(std::remove_if(appId.begin(), appId.end(), [](unsigned char c) { return std::isspace(c); }), appId.end());
    if (!appId.empty() && (appId.size() < 17 || appId.size() > 22 || !std::all_of(appId.begin(), appId.end(), [](unsigned char c) { return std::isdigit(c) != 0; }))) {
        MessageBoxW(g_window, L"Discord Application ID yalnızca 17–22 rakam olmalı.", kWindowTitle, MB_OK | MB_ICONWARNING);
        return;
    }

    Config updated;
    {
        std::lock_guard lock(g_stateMutex);
        updated = g_config;
    }
    updated.enabled = GetButtonCheck(GetDlgItem(g_window, IDC_ENABLED)) == BST_CHECKED;
    updated.selectedOnly = GetButtonCheck(GetDlgItem(g_window, IDC_SELECTED_ONLY)) == BST_CHECKED;
    updated.discordAppId = appId;
    updated.selectedPlaylistIds.clear();
    int count = ListView_GetItemCount(g_playlistView);
    for (int index = 0; index < count; ++index) {
        if (!ListView_GetCheckState(g_playlistView, index)) continue;
        wchar_t id[256]{};
        ListView_GetItemText(g_playlistView, index, 1, id, 256);
        updated.selectedPlaylistIds.insert(WideToUtf8(id));
    }
    {
        std::lock_guard lock(g_stateMutex);
        g_config = std::move(updated);
        SaveConfigLocked();
    }
    ProcessPresence();
    RefreshUi(false);
    MessageBoxW(g_window, L"Ayarlar kaydedildi.", kWindowTitle, MB_OK | MB_ICONINFORMATION);
}

void AddTrayIcon() {
    g_tray.cbSize = sizeof(g_tray);
    g_tray.hWnd = g_window;
    g_tray.uID = 1;
    g_tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    g_tray.uCallbackMessage = kTrayMessage;
    g_tray.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    wcscpy_s(g_tray.szTip, L"TuneCord");
    Shell_NotifyIconW(NIM_ADD, &g_tray);
    g_tray.uVersion = NOTIFYICON_VERSION_4;
    Shell_NotifyIconW(NIM_SETVERSION, &g_tray);
}

void ShowMainWindow() {
    ShowWindow(g_window, SW_SHOW);
    SetForegroundWindow(g_window);
}

void ShowTrayMenu() {
    POINT point{};
    GetCursorPos(&point);
    HMENU menu = CreatePopupMenu();
    AppendMenuW(menu, MF_STRING, IDM_TRAY_SHOW, L"TuneCord'u aç");
    bool enabled;
    {
        std::lock_guard lock(g_stateMutex);
        enabled = g_config.enabled;
    }
    AppendMenuW(menu, MF_STRING | (enabled ? MF_CHECKED : 0), IDM_TRAY_TOGGLE, L"Discord'da göster");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, IDM_TRAY_EXIT, L"Çıkış");
    SetForegroundWindow(g_window);
    TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, point.x, point.y, 0, g_window, nullptr);
    DestroyMenu(menu);
}

void LayoutControls(int width, int height) {
    const int margin = 32;
    const int contentWidth = width - margin * 2;
    MoveWindow(GetDlgItem(g_window, IDC_CONNECTION_STATUS), margin, 63, contentWidth, 22, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_NOW_PLAYING), margin, 89, contentWidth, 22, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_ENABLED), margin, 142, 220, 24, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_STARTUP), margin + 250, 142, 290, 24, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_DISCORD_ID), margin, 198, contentWidth - 246, 32, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_SAVE), width - margin - 108, 198, 108, 32, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_RESET_PAIRING), width - margin - 222, 198, 104, 32, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_ALL_TRACKS), margin, 258, 180, 24, TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_SELECTED_ONLY), margin + 190, 258, 270, 24, TRUE);
    MoveWindow(g_playlistView, margin, 338, contentWidth, std::max(100, height - 400), TRUE);
    MoveWindow(GetDlgItem(g_window, IDC_EXIT), width - margin - 86, height - 48, 86, 32, TRUE);
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
        case WM_CREATE: {
            g_window = hwnd;
            EnableModernWindowFrame(hwnd);
            g_backgroundBrush = CreateSolidBrush(kBackground);
            g_cardBrush = CreateSolidBrush(kCard);
            g_fieldBrush = CreateSolidBrush(kField);
            g_font = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                 CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Variable");
            g_titleFont = CreateFontW(-27, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                      CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Variable Display");
            g_smallFont = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                                      CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Variable");
            HWND title = AddControl(L"STATIC", L"TuneCord", SS_LEFT, 32, 26, 300, 32, -1);
            SendMessageW(title, WM_SETFONT, reinterpret_cast<WPARAM>(g_titleFont), TRUE);
            AddControl(L"STATIC", L"Eklenti: bekleniyor    •    Discord: bekleniyor", SS_LEFT, 32, 63, 620, 22, IDC_CONNECTION_STATUS);
            AddControl(L"STATIC", L"Şu an: bir şey çalmıyor", SS_LEFT | SS_PATHELLIPSIS, 32, 89, 620, 22, IDC_NOW_PLAYING);
            AddControl(L"BUTTON", L"Discord'da göster", BS_OWNERDRAW, 32, 142, 220, 24, IDC_ENABLED);
            AddControl(L"BUTTON", L"Windows açılışında tray'de başlat", BS_OWNERDRAW, 282, 142, 290, 24, IDC_STARTUP);
            AddControl(L"STATIC", L"DISCORD APPLICATION ID", SS_LEFT, 32, 174, 260, 20, -1);
            AddControl(L"EDIT", L"", ES_AUTOHSCROLL, 32, 198, 350, 32, IDC_DISCORD_ID);
            AddControl(L"BUTTON", L"Kaydet", BS_OWNERDRAW, 560, 198, 108, 32, IDC_SAVE);
            AddControl(L"BUTTON", L"Sıfırla", BS_OWNERDRAW, 446, 198, 104, 32, IDC_RESET_PAIRING);
            AddControl(L"STATIC", L"PLAYLIST FİLTRESİ", SS_LEFT, 32, 238, 260, 20, -1);
            AddControl(L"BUTTON", L"Tüm şarkılar", BS_OWNERDRAW, 32, 258, 180, 24, IDC_ALL_TRACKS);
            AddControl(L"BUTTON", L"Yalnızca seçili playlistler", BS_OWNERDRAW, 222, 258, 270, 24, IDC_SELECTED_ONLY);

            g_playlistView = CreateWindowExW(WS_EX_CLIENTEDGE, WC_LISTVIEWW, L"", WS_CHILD | WS_VISIBLE | LVS_REPORT | LVS_SHOWSELALWAYS,
                                              32, 338, 646, 205, hwnd, reinterpret_cast<HMENU>(IDC_PLAYLISTS), g_instance, nullptr);
            ApplyFont(g_playlistView);
            SetWindowTheme(g_playlistView, L"Explorer", nullptr);
            ListView_SetBkColor(g_playlistView, kField);
            ListView_SetTextBkColor(g_playlistView, kField);
            ListView_SetTextColor(g_playlistView, kText);
            ListView_SetExtendedListViewStyle(g_playlistView, LVS_EX_FULLROWSELECT | LVS_EX_CHECKBOXES | LVS_EX_DOUBLEBUFFER);
            LVCOLUMNW column{};
            column.mask = LVCF_TEXT | LVCF_WIDTH;
            column.pszText = const_cast<wchar_t*>(L"Playlist"); column.cx = 390; ListView_InsertColumn(g_playlistView, 0, &column);
            column.pszText = const_cast<wchar_t*>(L"Playlist ID"); column.cx = 220; ListView_InsertColumn(g_playlistView, 1, &column);
            AddControl(L"BUTTON", L"Çıkış", BS_OWNERDRAW, 582, 550, 86, 32, IDC_EXIT);

            AddTrayIcon();
            RefreshUi(true);
            SetTimer(hwnd, kPresenceTimer, 5000, nullptr);
            return 0;
        }
        case WM_PAINT:
            PaintBackground(hwnd);
            return 0;
        case WM_ERASEBKGND:
            return 1;
        case WM_CTLCOLORSTATIC: {
            HDC dc = reinterpret_cast<HDC>(wParam);
            const int id = GetDlgCtrlID(reinterpret_cast<HWND>(lParam));
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, (id == IDC_CONNECTION_STATUS || id == IDC_NOW_PLAYING) ? kMutedText : kText);
            if (id == -1) SetTextColor(dc, kAccentHover);
            return reinterpret_cast<LRESULT>(GetStockObject(NULL_BRUSH));
        }
        case WM_CTLCOLOREDIT: {
            HDC dc = reinterpret_cast<HDC>(wParam);
            SetTextColor(dc, kText);
            SetBkColor(dc, kField);
            return reinterpret_cast<LRESULT>(g_fieldBrush);
        }
        case WM_DRAWITEM:
            if (wParam != IDC_PLAYLISTS) {
                DrawOwnerButton(reinterpret_cast<const DRAWITEMSTRUCT*>(lParam));
                return TRUE;
            }
            break;
        case WM_SIZE:
            LayoutControls(LOWORD(lParam), HIWORD(lParam));
            return 0;
        case WM_GETMINMAXINFO: {
            auto* info = reinterpret_cast<MINMAXINFO*>(lParam);
            info->ptMinTrackSize.x = 620;
            info->ptMinTrackSize.y = 520;
            return 0;
        }
        case WM_COMMAND: {
            const int id = LOWORD(wParam);
            if (id == IDC_SAVE) SaveUiSettings();
            else if (id == IDC_ENABLED && HIWORD(wParam) == BN_CLICKED) {
                SetButtonCheck(GetDlgItem(hwnd, IDC_ENABLED), GetButtonCheck(GetDlgItem(hwnd, IDC_ENABLED)) == BST_CHECKED ? BST_UNCHECKED : BST_CHECKED);
                {
                    std::lock_guard lock(g_stateMutex);
                    g_config.enabled = GetButtonCheck(GetDlgItem(hwnd, IDC_ENABLED)) == BST_CHECKED;
                    SaveConfigLocked();
                }
                ProcessPresence();
            } else if (id == IDC_STARTUP && HIWORD(wParam) == BN_CLICKED) {
                SetButtonCheck(GetDlgItem(hwnd, IDC_STARTUP), GetButtonCheck(GetDlgItem(hwnd, IDC_STARTUP)) == BST_CHECKED ? BST_UNCHECKED : BST_CHECKED);
                bool enable = GetButtonCheck(GetDlgItem(hwnd, IDC_STARTUP)) == BST_CHECKED;
                if (!SetStartupEnabled(enable)) {
                    MessageBoxW(hwnd, L"Başlangıç ayarı değiştirilemedi.", kWindowTitle, MB_OK | MB_ICONERROR);
                    SetButtonCheck(GetDlgItem(hwnd, IDC_STARTUP), StartupEnabled() ? BST_CHECKED : BST_UNCHECKED);
                }
            } else if (id == IDC_ALL_TRACKS || id == IDC_SELECTED_ONLY) {
                SetButtonCheck(GetDlgItem(hwnd, IDC_ALL_TRACKS), id == IDC_ALL_TRACKS ? BST_CHECKED : BST_UNCHECKED);
                SetButtonCheck(GetDlgItem(hwnd, IDC_SELECTED_ONLY), id == IDC_SELECTED_ONLY ? BST_CHECKED : BST_UNCHECKED);
                {
                    std::lock_guard lock(g_stateMutex);
                    g_config.selectedOnly = id == IDC_SELECTED_ONLY;
                    SaveConfigLocked();
                }
                ProcessPresence();
            } else if (id == IDC_RESET_PAIRING) {
                std::lock_guard lock(g_stateMutex);
                g_config.bridgeToken = GenerateToken();
                SaveConfigLocked();
                MessageBoxW(hwnd, L"Eşleşme sıfırlandı. Eklenti popup'ından 'Yeniden bağlan'a bas.", kWindowTitle, MB_OK | MB_ICONINFORMATION);
            } else if (id == IDC_EXIT || id == IDM_TRAY_EXIT) {
                g_exitRequested = true;
                DestroyWindow(hwnd);
            } else if (id == IDM_TRAY_SHOW) ShowMainWindow();
            else if (id == IDM_TRAY_TOGGLE) {
                {
                    std::lock_guard lock(g_stateMutex);
                    g_config.enabled = !g_config.enabled;
                    SaveConfigLocked();
                }
                RefreshUi(false);
                ProcessPresence();
            }
            return 0;
        }
        case WM_NOTIFY: {
            const auto* notify = reinterpret_cast<LPNMHDR>(lParam);
            if (notify->idFrom == IDC_PLAYLISTS && notify->code == NM_CUSTOMDRAW) {
                auto* draw = reinterpret_cast<LPNMLVCUSTOMDRAW>(lParam);
                if (draw->nmcd.dwDrawStage == CDDS_PREPAINT) return CDRF_NOTIFYITEMDRAW;
                if (draw->nmcd.dwDrawStage == CDDS_ITEMPREPAINT) {
                    draw->clrText = kText;
                    draw->clrTextBk = kField;
                    return CDRF_NEWFONT;
                }
            }
            if (notify->idFrom == IDC_PLAYLISTS && !g_fillingPlaylists) {
                // Seçimler Kaydet düğmesine basılınca merkezi ayara yazılır.
            }
            return 0;
        }
        case WM_TIMER:
            if (wParam == kPresenceTimer) {
                ProcessPresence();
                RefreshUi(false);
            }
            return 0;
        case kRefreshMessage:
            ProcessPresence();
            RefreshUi(wParam != 0);
            return 0;
        case kTrayMessage:
            if (LOWORD(lParam) == WM_LBUTTONUP || LOWORD(lParam) == NIN_SELECT) ShowMainWindow();
            else if (LOWORD(lParam) == WM_RBUTTONUP || LOWORD(lParam) == WM_CONTEXTMENU) ShowTrayMenu();
            return 0;
        case WM_CLOSE:
            if (!g_exitRequested) { ShowWindow(hwnd, SW_HIDE); return 0; }
            break;
        case WM_DESTROY: {
            KillTimer(hwnd, kPresenceTimer);
            g_discord.ClearActivity();
            g_discordConnected = false;
            Shell_NotifyIconW(NIM_DELETE, &g_tray);
            g_running = false;
            SOCKET server = g_listenSocket.exchange(INVALID_SOCKET);
            if (server != INVALID_SOCKET) closesocket(server);
            if (g_font) DeleteObject(g_font);
            if (g_titleFont) DeleteObject(g_titleFont);
            if (g_smallFont) DeleteObject(g_smallFont);
            if (g_backgroundBrush) DeleteObject(g_backgroundBrush);
            if (g_cardBrush) DeleteObject(g_cardBrush);
            if (g_fieldBrush) DeleteObject(g_fieldBrush);
            PostQuitMessage(0);
            return 0;
        }
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR commandLine, int showCommand) {
    HANDLE singleton = CreateMutexW(nullptr, TRUE, L"Local\\TuneCord.Singleton");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        if (HWND existing = FindWindowW(kWindowClass, nullptr)) {
            ShowWindow(existing, SW_SHOW);
            SetForegroundWindow(existing);
        }
        CloseHandle(singleton);
        return 0;
    }

    g_instance = instance;
    LoadConfig();
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_LISTVIEW_CLASSES | ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&controls);

    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc = WindowProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    wc.lpszClassName = kWindowClass;
    wc.style = CS_HREDRAW | CS_VREDRAW;
    RegisterClassExW(&wc);

    HWND window = CreateWindowExW(0, kWindowClass, kWindowTitle, WS_OVERLAPPEDWINDOW,
                                  CW_USEDEFAULT, CW_USEDEFAULT, 720, 590, nullptr, nullptr, instance, nullptr);
    if (!window) {
        CloseHandle(singleton);
        return 1;
    }

    std::thread serverThread(BridgeServer);
    bool startInTray = commandLine && wcsstr(commandLine, L"--tray");
    if (!startInTray) ShowWindow(window, showCommand);
    UpdateWindow(window);

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    g_running = false;
    SOCKET server = g_listenSocket.exchange(INVALID_SOCKET);
    if (server != INVALID_SOCKET) closesocket(server);
    if (serverThread.joinable()) serverThread.join();
    CloseHandle(singleton);
    return static_cast<int>(message.wParam);
}
