# 日历官方登录：Google / Microsoft 应用注册指南

Stillnote 现在通过 Mac 日历（EventKit）或粘贴的日历私密链接读会议。要做到「用 Google / Microsoft 账号登录」，需要先以开发者身份注册一个 OAuth 应用，拿到 client ID。本文是注册步骤和审核要求（2026-10-30 查证）。拿到 client ID 后，登录代码沿用 `app/auth.mjs` 已有的 PKCE + `127.0.0.1` 回调。

Stillnote 只读日历会议，不读邮件，所以只申请只读日历权限。

## 准备

- 一个你拥有的域名，放一个公开主页和隐私政策页（GitHub Pages、Vercel 都可以）。Google 审核要求两者在同一个域名下，并在 Google Search Console 验证所有权。
- 一个 Google 账号，用来持有 Google Cloud 项目。
- 一个 Microsoft 账号，用来持有 Entra 应用注册。

隐私政策至少要写清楚：读取哪些日历数据、只保存在本机、不上传到任何服务器、怎样断开连接并删除数据。

## Google

在 [Google Cloud Console](https://console.cloud.google.com/) 操作：

1. **新建项目**，例如 `Stillnote`。
2. **APIs & Services → Library**，启用 **Google Calendar API**。
3. **Google Auth Platform → Branding**：填写应用名（Stillnote）、支持邮箱、Logo、主页链接、隐私政策链接，以及 Authorized domains（你的域名）。
4. **Audience**：User type 选 **External**。Publishing status 先保持 **Testing**，在 Test users 里加上自己的 Google 账号（最多 100 个测试用户）。
5. **Data Access → Add or remove scopes**，只加两个只读权限：
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`：读取日历列表（名称、颜色）。
   - `https://www.googleapis.com/auth/calendar.events.readonly`：读取各日历上的事件。

   不要申请 `calendar` 或 `calendar.events` 这类写权限。审核时需要说明为什么更窄的权限不够，越窄越好过。
6. **Clients → Create client**，类型选 **Desktop app**，记下 **Client ID**。Desktop 类型的 client secret 并不是真正的机密，Google 允许打包进应用；回调使用 loopback 地址（`http://127.0.0.1:<端口>`）。

### Testing 状态（自用够了）

- 只有 Test users 列表里的账号能登录。
- refresh token **7 天过期**，每周要重新登录一次。
- 不需要提交审核。

### 发布到 Production

- 不提交审核也能直接发布，但别人登录时会看到「Google 尚未验证此应用」的警告，并有用户数上限。
- 正式审核（sensitive scope verification）的要求：
  - 主页公开可访问，隐私政策在同一域名下，并从授权页链接过去。
  - 在 Search Console 验证域名。
  - 为每个权限写用途说明。
  - 一段上传到 YouTube（Unlisted）的演示视频：展示授权流程、授权页上的应用名、地址栏里的 client ID，以及每个权限在应用里的用法。
  - 官方说审核最长约 10 天。
- 日历权限属于 sensitive，不是 restricted（Gmail 这类才是），所以**不需要**付费的第三方安全评估（CASA）。
- 从 Testing 切到 Production 后，已有的 token 不会自动升级，需要重新登录。

参考：[Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)、[Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)

## Microsoft（Outlook / Microsoft 365）

在 [Microsoft Entra admin center](https://entra.microsoft.com/) 操作，个人 Microsoft 账号也能登录：

1. **Applications → App registrations → New registration**。
   - Name：Stillnote。
   - Supported account types：选 **Any Entra ID tenant + Personal Microsoft accounts**（同时支持公司账号和个人 outlook.com 账号）。
   - Redirect URI：平台选 **Public client/native (mobile & desktop)**，填 `http://localhost`。桌面应用回调可以使用任意端口的 localhost。
2. **Authentication**：打开 **Allow public client flows**。不要创建 client secret，桌面应用用 PKCE。
3. **API permissions → Add a permission → Microsoft Graph → Delegated**，添加：
   - `Calendars.Read`
   - `User.Read`
   - `offline_access`

   这几个一般不需要管理员同意。
4. 在 **Overview** 里记下 **Application (client) ID**。

### 发布者验证（Publisher verification）

- 没有验证时，授权页会在应用名旁边显示「未验证」。很多公司租户不允许员工给未验证发布者的多租户应用授权，公司账号可能登录不了。个人账号不受影响。
- 验证需要加入 Microsoft AI Cloud Partner Program，拿到 Partner ID（原 MPN ID），再把它关联到应用注册。

## 拿到之后

把 Google 的 Client ID 和 Microsoft 的 Application (client) ID 发给我，我来接登录代码：

- 用系统浏览器登录，回调走 `127.0.0.1`，PKCE S256。
- token 用 `safeStorage` 加密保存，和 ChatGPT 凭据一样不进入备份。
- 事件转换成和 Mac 日历相同的结构，提醒、自动建笔记、加入会议都不用改。
