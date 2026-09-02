package com.coldtank.resume.wxapi;

import ee.forgr.plugin.capacitor_wechat.WechatResponseActivity;

/**
 * 微信登录 / 分享回调入口。
 *
 * 微信 SDK 的硬要求（不满足就是静默失败，没有任何报错）：
 *   1. 全限定类名必须是 <应用包名>.wxapi.WXEntryActivity
 *   2. 必须在 AndroidManifest 中注册且 android:exported="true"
 * 这里只做继承，具体事件处理由插件的 WechatResponseActivity 完成。
 */
public class WXEntryActivity extends WechatResponseActivity {
}
