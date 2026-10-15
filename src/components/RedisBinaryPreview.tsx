import { useMemo } from "react";
import { tx } from "../lib/i18n";
import { redisBinaryInfo } from "../lib/redis-binary";
import { redisDisplay, type RedisBlob } from "../lib/redis";

export function RedisBinaryPreview({ value, offset }: { value: RedisBlob; offset: number }) {
  const info = useMemo(() => redisBinaryInfo(value, offset), [value, offset]);
  return (
    <div className="redis-binary-preview">
      <h3>{tx("十六进制（前 256 字节）")}</h3>
      <pre className="redis-preview">{redisDisplay(value)}</pre>
      <section aria-label={tx("序列化信息")}>
        <h3>{tx("序列化信息")}</h3>
        <dl>
          <dt>{tx("格式")}</dt>
          <dd>{info.java ? "Java Object Serialization" : tx("未识别（二进制）")}</dd>
          {info.java && (
            <>
              <dt>{tx("流版本")}</dt>
              <dd>{info.java.version}</dd>
              {info.java.className !== null && (
                <>
                  <dt>{tx("类名")}</dt>
                  <dd>{info.java.className}</dd>
                </>
              )}
              {info.java.serialVersionUid !== null && (
                <>
                  <dt>{tx("序列版本 UID")}</dt>
                  <dd>{info.java.serialVersionUid}</dd>
                </>
              )}
            </>
          )}
        </dl>
        {!!info.java?.fields.length && (
          <details className="redis-binary-field-details">
            <summary>{tx("字段信息（{count}）", { count: info.java.fields.length })}</summary>
            <div className="redis-binary-fields">
              <table>
                <thead>
                  <tr>
                    <th>{tx("字段名")}</th>
                    <th>{tx("字段类型")}</th>
                  </tr>
                </thead>
                <tbody>
                  {info.java.fields.map((field, index) => (
                    <tr key={index}>
                      <td>{field.name}</td>
                      <td>{field.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        {info.java?.partial && (
          <p className="muted">{tx("类描述未完整读取或暂不支持，仅显示已识别的信息。")}</p>
        )}
        <h3>{tx("可读文本（UTF-8）")}</h3>
        <p className="muted">
          {tx("控制字符显示为 ·，无效 UTF-8 字节显示为 �。此视图不还原完整对象。")}
        </p>
        {info.limited && (
          <p role="status">{tx("可读预览仅显示当前页前 {count} 字节。", { count: info.bytes })}</p>
        )}
        <pre className="redis-preview redis-readable-preview">
          {info.text || tx("无可读内容。")}
        </pre>
      </section>
    </div>
  );
}
