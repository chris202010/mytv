// 核心配置常量
const AUTH_TOKEN = "mytv123"; // 你自己用来限制别人盗刷你 Worker 的防盗链 Token
const ERROR_REDIRECT_URL = "https://cdn5.163189.xyz/403/?mytv";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userAgent = request.headers.get("user-agent") || "";
    const path = url.pathname; // 提前定义 path，防止鉴权逻辑中报错引用未定义变量

    // 1. UA 拦截逻辑 (1:1 复刻 Nginx)
    let isPlayer = true;
    const browserRegex = /Mozilla|Chrome|Safari|Edge|Android/i;
    const playerRegex = /TiviMate|APTV|aptv|VLC|AppleCoreMedia|Apple/i;
    if (browserRegex.test(userAgent) && !playerRegex.test(userAgent)) {
      isPlayer = false;
    }

    // 2. 鉴权逻辑 (检查 Token)
    let token = url.searchParams.get("token");
    if (!token) {
      const cookies = request.headers.get("Cookie") || "";
      const cookieMatch = cookies.match(/(?:^|; )token=([^;]*)/);
      if (cookieMatch) token = cookieMatch[1];
    }

    // 鉴权放行与拦截判定
    const isStreamLink = path.startsWith("/stream-link") || path.startsWith("/p/");
    if (!isStreamLink) {
      // 针对订阅端和普通的直播集群端口，必须严格验证你的 AUTH_TOKEN
      if (token !== AUTH_TOKEN) {
        return Response.redirect(ERROR_REDIRECT_URL, 302);
      }
    } else {
      // 针对 stream-link 业务：如果是播放器发起的 /p/ 视频片段请求，允许无 token 放行
      // 如果是请求 .m3u 列表，必须在 URL 后面带上官方机器人给的动态 token
      if (path.endsWith(".m3u") && !token) {
        return new Response("Missing stream-link token", { status: 403 });
      }
    }

    // 3. 浏览器访问带 token 时，写 Cookie 并移除 URL 参数防盗链 (1:1 复刻 Nginx)
    if (url.searchParams.has("token") && !isPlayer) {
      const redirectUrl = new URL(request.url);
      redirectUrl.searchParams.delete("token");
      return new Response("", {
        status: 302,
        headers: {
          "Location": redirectUrl.toString(),
          "Set-Cookie": `token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`
        }
      });
    }

    // =========================================================================
    // 4. 路由分发集群
    // =========================================================================

    // ----- 【业务 A：M3U 订阅端完美修复 (对应 Nginx 30000 端口)】 -----
    if (path === "/mytv.m3u") {
      const targetUrl = "https://cdn.qd.je/mytv.m3u";
      let response = await fetch(targetUrl, { headers: { "Host": "cdn.qd.je" } });
      let text = await response.text();
      
      text = text.replaceAll('服务器ip', url.host);
      text = text.replaceAll('.m3u8', `.m3u8?token=${AUTH_TOKEN}`);
      text = text.replaceAll('smt3.2.1.php?', `smt3.2.1.php?token=${AUTH_TOKEN}&`);
      text = text.replaceAll('?u=test', '&u=test'); 
      text = text.replaceAll('?163189', `?163189&token=${AUTH_TOKEN}`);
      
      return cleanHeaders(new Response(text, response));
    }

    // ----- 【业务 B：stream-link 转换 (对应 Nginx 30001 端口)】 -----
    if (isStreamLink) {
      // 1. 处理请求 M3U 列表文件
      if (path.endsWith(".m3u")) {
        const botToken = token || ""; // 使用传入的机器人专属 token
        const targetUrl = `https://www.stream-link.org${path.replace("/stream-link", "")}?token=${botToken}`;
        
        let response = await fetch(targetUrl, {
          headers: {
            "Host": "www.stream-link.org",
            "User-Agent": "TiviMate/5.1.0",
            "Accept": "*/*"
          }
        });
        
        let text = await response.text();
        text = text.replaceAll('https://', `https://${url.host}/p/https://`);
        return cleanHeaders(new Response(text, response));
      }
      
      // 2. 代理通用 HLS /p/ 视频流路径
      if (path.startsWith("/p/")) {
        const match = path.match(/^\/p\/(https?:\/\/([^\/]+))(\/.*)$/);
        if (!match) return new Response("Invalid Proxy URL", { status: 404 });
        
        const upstreamTarget = match[1] + match[3] + url.search;
        const upstreamHost = match[2];
        
        let response = await fetch(upstreamTarget, {
          redirect: "manual", // 拦截重定向
          headers: {
            "Host": upstreamHost,
            "User-Agent": "TiviMate/5.1.0",
            "Referer": "https://www.stream-link.org/"
          }
        });
        
        // 处理 301/302 重定向
        if ([301, 302, 307].includes(response.status)) {
          let location = response.headers.get("Location");
          if (location && location.startsWith("/")) {
            location = `https://${upstreamHost}${location}`;
          }
          return Response.redirect(`https://${url.host}/p/${location}`, 302);
        }
        
        // 如果是 M3U8 文本，进行 sub_filter 替换
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("mpegurl") || contentType.includes("text")) {
          let text = await response.text();
          text = text.replaceAll('/2600_', `https://${url.host}/p/https://${upstreamHost}/2600_`);
          text = text.replaceAll('/hls_', `https://${url.host}/p/https://${upstreamHost}/hls_`);
          text = text.replaceAll('https://', `https://${url.host}/p/https://`);
          return cleanHeaders(new Response(text, response));
        }
        
        return cleanHeaders(response);
      }
    }

    // ----- 【业务 C：直播流反代集群 (对应 Nginx 20000 - 20010 端口)】 -----
    const portMatch = path.match(/^\/port\/(\d+)(\/.*)?$/);
    if (portMatch) {
      const portNum = parseInt(portMatch[1]);
      const subPath = portMatch[2] || "/";
      let upstreamHost = "";
      let doSubFilter = false;
      let logKey = portNum.toString();

      switch (portNum) {
        case 20000: upstreamHost = "cdn.123.rr.kg"; break;
        case 20001: upstreamHost = "cdn3.123.rr.kg"; break;
        case 20002: upstreamHost = "cdn16.123.rr.kg"; break;
        case 20003: upstreamHost = "cdn6.123.rr.kg"; break;
        case 20004: upstreamHost = "cdn12.123.rr.kg"; doSubFilter = true; logKey = "12"; break;
        case 20005: upstreamHost = "cdn15.123.rr.kg"; break;
        case 20006: upstreamHost = "o11.163189.xyz"; break;
        case 20007: upstreamHost = "cdn2.123.rr.kg"; break;
        case 20008: upstreamHost = "cdn8.123.rr.kg"; break;
        case 20009: upstreamHost = "cdn10.123.rr.kg"; break;
        case 20010: 
          if (subPath.startsWith("/cdn13/")) {
            return handleClusterFetch("cdn13.123.rr.kg", subPath.replace("/cdn13", ""), url, true, "cdn13");
          } else if (subPath.startsWith("/o12/")) {
            return handleClusterFetch("o12.123.rr.kg", subPath.replace("/o12", ""), url, false, "o12");
          } else if (subPath.startsWith("/smt/")) {
            return handleClusterFetch("smt.123.rr.kg", subPath.replace("/smt", ""), url, true, "smt");
          } else {
            return handleClusterFetch("cdn11.123.rr.kg", subPath, url, true, "cdn11");
          }
        default:
          return new Response("Port Not Found", { status: 404 });
      }

      return handleClusterFetch(upstreamHost, subPath, url, doSubFilter, logKey);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleClusterFetch(host, subPath, currentUrl, doSubFilter, logKey) {
  const target = `https://${host}${subPath}${currentUrl.search}`;
  let response = await fetch(target, { headers: { "Host": host } });

  if (doSubFilter) {
    let text = await response.text();
    if (logKey === "12" || logKey === "cdn11") {
      text = text.replaceAll(`https://${host}/`, `https://${currentUrl.host}/port/20004/`);
    } else if (logKey === "cdn13") {
      text = text.replaceAll('/api', '/port/20010/cdn13/api');
    } else if (logKey === "smt") {
      text = text.replaceAll('/api', '/port/20010/smt/api');
    }
    return cleanHeaders(new Response(text, response));
  }

  return cleanHeaders(response);
}

function cleanHeaders(response) {
  let newHeaders = new Headers(response.headers);
  const hideHeaders = ["Server", "CF-Cache-Status", "CF-Ray", "Alt-Svc", "Expect-CT", "report-to", "Nel", "server-timing"];
  hideHeaders.forEach(h => newHeaders.delete(h));
  newHeaders.set("X-Proxy-By", "Cloudflare-Workers-Custom");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
}
