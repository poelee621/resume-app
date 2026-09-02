package com.coldtank.resume;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        /* 自定义插件必须在 super.onCreate() 之前注册，否则 Bridge 初始化时拿不到 */
        registerPlugin(ResumeSavePlugin.class);
        super.onCreate(savedInstanceState);
        /* 真机下载：WebView 里 a[download]/blob 下载 → 保存到系统 Download 目录 */
        getBridge().getWebView().setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                try {
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                    request.setMimeType(mimetype == null ? "application/octet-stream" : mimetype);
                    request.addRequestHeader("User-Agent", userAgent);
                    request.setDescription("简历大师导出文件");
                    request.setTitle(URLUtil.guessFileName(url, contentDisposition, "resume"));
                    request.allowScanningByMediaScanner();
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, contentDisposition, "resume"));
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) dm.enqueue(request);
                } catch (Exception ignored) {}
            }
        });
    }
}
