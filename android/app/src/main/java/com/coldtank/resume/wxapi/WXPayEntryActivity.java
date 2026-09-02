package com.coldtank.resume.wxapi;

import ee.forgr.plugin.capacitor_wechat.WechatResponseActivity;

/**
 * 微信支付回调入口。
 *
 * 微信 SDK 的硬要求（不满足就是静默失败，用户付了钱 App 也不知道）：
 *   1. 全限定类名必须是 <应用包名>.wxapi.WXPayEntryActivity
 *   2. 必须在 AndroidManifest 中注册且 android:exported="true"
 * 注意：即便微信回调了，最终是否解锁仍以后端 /pay/status 查微信支付订单为准，
 * 客户端回调只用来尽早触发轮询。
 */
public class WXPayEntryActivity extends WechatResponseActivity {
}
