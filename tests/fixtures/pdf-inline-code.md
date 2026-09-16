# PDF 行内代码换行验证

这段文字用于检查行内代码出现在行尾时的导出效果。请保留完整的前后文，确认背景不会遮住汉字，也不会把末尾字符拆成上下两半。测试代码为 `example:collection:{identifier}`，之后的说明文字也必须完整可见。继续补充几句话，让这一段自然换行，检查代码两侧的正文是否正常。

这段文字用于检查短代码与中文混排：`sampleValue` 应当保留原有颜色和背景，句子中的 `ROUND_UP` 也应正常显示。

超过一行宽度的代码仍需折行，不能横向裁切：`example_collection_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz`。这是长代码之后的正文。

| 场景 | 内容 |
| --- | --- |
| 表格内代码 | 前面的中文 `example:collection:{identifier}` 后面的中文 |
| 普通单元格 | 不应受到代码样式影响 |

```text
代码块仍保持原有格式：
    key = value
    example --options=abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuvwxyz
```
