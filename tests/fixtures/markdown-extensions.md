---
slug: /redis-practical-guide
title: Redis 常用命令与实战手册
tags: [Redis, 缓存]
sidebar:
  order: 1
description: >-
  常见语法兼容性验证，元数据只显示 title。
---

[跳转到常用命令](#常用命令)

> [!NOTE]
> 这是 GitHub 提示块，支持 **加粗** 和 `行内代码`。

:::tip[使用建议]
操作之前先检查环境。

- 确认配置
- 阅读说明[^redis]
:::

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `GET key` | 读取字符串 |
| `SET key value` | 写入字符串 |

```bash title="redis-cli" {1}
redis-cli GET example
```

- [x] 支持表格和代码高亮
- [ ] 检查真实文档

~~旧说明~~，新说明再次引用脚注[^redis]。

## YAML 代码示例

下面的内容仍是代码，不会被当成当前文档的元数据：

```yaml
---
slug: /example
title: 示例标题
---
```

## 图表与公式

```mermaid
flowchart LR
    Client[客户端] --> Redis[缓存]
```

$$E = mc^2$$

<details>
<summary>展开说明</summary>

这是 **折叠内容**。

</details>

[^redis]: 脚注支持 **格式化文本**。

    也支持第二段说明和回到每处引用的链接。

文档结束。
