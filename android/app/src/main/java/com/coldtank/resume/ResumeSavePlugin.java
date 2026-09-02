package com.coldtank.resume;

import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/**
 * 保存简历 PNG 到系统相册「Pictures/AI简历工坊/」。
 *
 * 为什么不用 @capacitor-community/media：
 *  该插件 Android 端 _saveMedia() 强制要求 albumIdentifier（目录路径），
 *  且其 _getAlbumsPath() 使用 getExternalMediaDirs()[0]（Android 11 起废弃，
 *  指向 Android/media/<包名>/），多数 ROM 的相册不扫描该目录 —— 存进去也找不到。
 *
 * 本实现采用 Android 官方推荐的 MediaStore + RELATIVE_PATH 方案：
 *  - API 29+：写 Pictures/AI简历工坊/，属于公共媒体目录，免任何存储权限，相册立即可见
 *  - API 28-：无 RELATIVE_PATH，直接抛 UNAVAILABLE，前端回退到 Download 目录下载
 */
@CapacitorPlugin(name = "ResumeSave")
public class ResumeSavePlugin extends Plugin {

    private static final String ALBUM = "AI简历工坊";

    @PluginMethod
    public void savePng(PluginCall call) {
        String dataUrl = call.getString("dataUrl");
        String fileName = call.getString("fileName");

        if (dataUrl == null || dataUrl.isEmpty()) {
            call.reject("dataUrl is required", "ARG_ERROR");
            return;
        }
        if (fileName == null || fileName.isEmpty()) {
            fileName = "resume_" + System.currentTimeMillis();
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            /* Android 9 及以下：无 RELATIVE_PATH，需要 WRITE_EXTERNAL_STORAGE 才能写公共目录。
               为避免为 <5% 的老设备引入权限审核成本，这里直接让前端走 Download 兜底。 */
            call.reject("UNSUPPORTED_ANDROID_VERSION", "UNAVAILABLE");
            return;
        }

        try {
            int comma = dataUrl.indexOf(',');
            String base64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName + ".png");
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            values.put(MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + "/" + ALBUM);
            values.put(MediaStore.Images.Media.IS_PENDING, 1);

            Uri uri = getContext().getContentResolver()
                    .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("MediaStore insert returned null", "IO_ERROR");
                return;
            }

            OutputStream os = getContext().getContentResolver().openOutputStream(uri);
            if (os == null) {
                call.reject("Cannot open output stream", "IO_ERROR");
                return;
            }
            os.write(bytes);
            os.flush();
            os.close();

            /* 收尾：解除 pending，让相册立刻索引到 */
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            getContext().getContentResolver().update(uri, values, null, null);

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("save failed: " + e.getMessage(), "IO_ERROR");
        }
    }
}
