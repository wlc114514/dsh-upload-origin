# dsh-upload-origin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的主机端插件：当用户把文件拖进会话后，反查出该文件的**原始本地绝对路径**。

## 为什么需要它

浏览器拖拽上传时，出于安全限制，前端只能拿到文件内容和显示文件名，拿不到原始绝对路径。DSH 会把上传快照存到：

```text
<session cwd>/.dsh-uploads/<sessionId>/<sha256-16>-<name>
```

`dsh-upload-origin` 运行在 DSH 主机端，扫描会话工作目录和常用用户目录，用**文件名 + 大小 + sha256** 匹配本地原文件。匹配到的原路径会注入当前 agent 的系统提示，同时通过工具提供按需查询。

## 功能

1. 每轮组装时检查当前会话的 `.dsh-uploads` 目录。
2. 只处理人类消息中实际引用过的上传文件。
3. 解析原路径：
   - 优先使用官方工作区文件索引 `ctx.fileReferences`；
   - 然后在会话工作目录、`Desktop`、`Documents`、`Downloads`、`OneDrive` 以及主目录浅层做有界文件系统扫描。
4. 注入系统提示：

   ```text
   [Uploaded files: original local paths]
   - uploaded: .dsh-uploads/session-.../7538541a1efdc6c6-报告.docx
     original: C:\Users\Alice\Desktop\报告.docx [exact]
     用户指自己的本地文件时优先使用该原路径；.dsh-uploads 里的是快照。
   ```

5. 注册 `resolve_uploaded_file` 工具，供模型按需调用。

## 安装

从源码安装：

```sh
dsh plugin --profile web add dsh-upload-origin
```

或安装已发布的 tarball。

包内声明了 `dsh.bundle`，可按 DSH 正常的 bundle/profile 流程安装。

## 工具：`resolve_uploaded_file`

参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `file_path` | string，可选 | 上传文件路径，绝对路径或相对会话工作目录。 |
| `name` | string，可选 | 已知原始文件名，但没有上传路径时使用。 |
| `search_roots` | string[]，可选 | 额外扫描的绝对目录。 |
| `max_results` | integer，可选 | 最多返回多少个候选（1-20，默认 10）。 |

返回值包含上传路径、原始文件名、大小、sha256、最可能的原路径、置信度、候选列表、扫描目录和扫描统计。

置信度：

| 置信度 | 含义 |
|---|---|
| `exact` | 文件名、大小、sha256 全部匹配。 |
| `name+size` | 文件名和大小匹配；sha256 未检查或不一致。 |
| `name+size-hash-differs` | 文件名和大小匹配，但上传后内容已变化。 |
| `name-only-size-differs` | 同名但大小不同。 |
| `name-only` | 仅文件名匹配，需要人工确认。 |

## 配置

可在 bundle patch row 中传入可选配置：

```yaml
- id: upload-origin
  name: 'dsh-upload-origin'
  config:
    maxSearchFiles: 250000
    searchTimeoutMs: 9000
    maxDepth: 12
    maxHashChecks: 30
    maxResults: 10
    recentUploadMs: 604800000
    maxRecentUploads: 8
    autoResolveTimeoutMs: 7000
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `maxSearchFiles` | `250000` | 单次解析最多访问的文件系统条目数。 |
| `searchTimeoutMs` | `9000` | 单次解析的总搜索时限。 |
| `maxDepth` | `12` | 常用目录的最大扫描深度。 |
| `maxHashChecks` | `30` | 最多对多少个候选计算内容哈希。 |
| `maxResults` | `10` | 工具最多返回的候选数。 |
| `recentUploadMs` | `604800000` | 只自动解析此时间内的上传（7 天）。 |
| `maxRecentUploads` | `8` | 每次提示组装最多考虑多少个最近上传。 |
| `autoResolveTimeoutMs` | `7000` | 每轮自动映射原路径的最长等待时间。 |

## 限制

- 浏览器不会在拖拽时暴露原始绝对路径；本插件通过主机端匹配上传快照来恢复。
- 如果原文件在上传后被修改，sha256 会不一致；插件会回退到 `name+size` 或仅文件名候选。
- 默认目录之外的文件不会自动找到；调用工具时可传 `search_roots`。
- 上传副本仍然是读取时的可靠来源；原路径用于用户要编辑本地文件的场景。

## 安全

- 仅在主机端运行，不发起网络请求。
- 不读取、不存储、不传输任何凭据。
- 只读取与上传文件名相同的本地文件，并在本地计算内容哈希确认。
- `resolve_uploaded_file` 工具是只读的。

## 许可证

MIT
