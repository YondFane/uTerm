import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/** Exercises the bundled writer without a database or third-party driver. 无需数据库或第三方驱动即可验证内置序列化器。 */
public final class DatabaseJsonProbe {
    /** Emits an escaping and precision fixture after checking the round trip. 验证往返解析后输出转义和精度样本。 */
    public static void main(String[] args) throws Exception {
        Class<?> json = Class.forName("Json");
        Method write = json.getDeclaredMethod("write", Object.class);
        Method parse = json.getDeclaredMethod("parse", String.class);
        Method length = json.getDeclaredMethod("length", Object.class);
        length.setAccessible(true);
        write.setAccessible(true);
        parse.setAccessible(true);
        StringBuilder controls = new StringBuilder();
        for (char value = 0; value < 32; value++) controls.append(value);
        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("controls", controls.toString());
        fixture.put("text", "中文𐐀\"\\\n\r\t");
        fixture.put("nested", Arrays.asList(null, true, Map.of("number", new BigDecimal("12345678901234567890.125"))));
        String encoded = (String) write.invoke(null, fixture);
        if (!Integer.valueOf(encoded.length()).equals(length.invoke(null, fixture))) throw new AssertionError("JSON length differs");
        if (!fixture.equals(parse.invoke(null, encoded))) throw new AssertionError("JSON round trip differs");
        System.out.write(encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
