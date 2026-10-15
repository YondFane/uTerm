import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Bounded JSON transport without a bundled dependency. 无额外依赖的有界 JSON 传输。 */
final class Json {
    private final String input;
    private int offset;

    private Json(String input) { this.input = input; }

    static Object parse(String input) {
        Json parser = new Json(input);
        Object value = parser.read(0);
        parser.space();
        if (parser.offset != input.length()) throw new IllegalArgumentException("DB_PROTOCOL");
        return value;
    }

    private void space() {
        while (offset < input.length() && Character.isWhitespace(input.charAt(offset))) offset++;
    }

    private Object read(int depth) {
        space();
        if (depth > 32 || offset >= input.length()) throw new IllegalArgumentException("DB_PROTOCOL");
        char c = input.charAt(offset++);
        if (c == '"') {
            StringBuilder text = new StringBuilder();
            while (offset < input.length()) {
                c = input.charAt(offset++);
                if (c == '"') return text.toString();
                if (c < 32) throw new IllegalArgumentException("DB_PROTOCOL");
                if (c == '\\') {
                    c = input.charAt(offset++);
                    switch (c) {
                        case '"', '\\', '/' -> text.append(c);
                        case 'b' -> text.append('\b');
                        case 'f' -> text.append('\f');
                        case 'n' -> text.append('\n');
                        case 'r' -> text.append('\r');
                        case 't' -> text.append('\t');
                        case 'u' -> {
                            text.append((char) Integer.parseInt(input.substring(offset, offset + 4), 16));
                            offset += 4;
                        }
                        default -> throw new IllegalArgumentException("DB_PROTOCOL");
                    }
                } else text.append(c);
            }
            throw new IllegalArgumentException("DB_PROTOCOL");
        }
        if (c == '{' || c == '[') {
            Map<String, Object> map = new LinkedHashMap<>();
            List<Object> list = new ArrayList<>();
            space();
            if (offset < input.length() && input.charAt(offset) == (c == '{' ? '}' : ']')) {
                offset++;
                return c == '{' ? map : list;
            }
            while (true) {
                if (c == '{') {
                    Object key = read(depth + 1);
                    space();
                    if (!(key instanceof String) || input.charAt(offset++) != ':')
                        throw new IllegalArgumentException("DB_PROTOCOL");
                    if (map.containsKey(key)) throw new IllegalArgumentException("DB_PROTOCOL");
                    map.put((String) key, read(depth + 1));
                } else list.add(read(depth + 1));
                space();
                char next = input.charAt(offset++);
                if (next == (c == '{' ? '}' : ']')) return c == '{' ? map : list;
                if (next != ',') throw new IllegalArgumentException("DB_PROTOCOL");
            }
        }
        offset--;
        for (String token : List.of("true", "false", "null")) {
            if (input.startsWith(token, offset)) {
                offset += token.length();
                return token.equals("null") ? null : token.equals("true");
            }
        }
        int start = offset;
        while (offset < input.length() && "-+0123456789.eE".indexOf(input.charAt(offset)) >= 0) offset++;
        if (start == offset) throw new IllegalArgumentException("DB_PROTOCOL");
        return new BigDecimal(input.substring(start, offset));
    }

    static String write(Object value) {
        StringBuilder output = new StringBuilder();
        append(output, value);
        return output.toString();
    }

    private static void append(StringBuilder output, Object value) {
        if (value == null || value instanceof Boolean || value instanceof Number) {
            output.append(value);
            return;
        }
        if (value instanceof Map<?, ?> map) {
            output.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) output.append(',');
                append(output, entry.getKey().toString());
                output.append(':');
                append(output, entry.getValue());
                first = false;
            }
            output.append('}');
            return;
        }
        if (value instanceof Iterable<?> items) {
            output.append('[');
            boolean first = true;
            for (Object item : items) {
                if (!first) output.append(',');
                append(output, item);
                first = false;
            }
            output.append(']');
            return;
        }
        output.append('"');
        String text = value.toString();
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            switch (c) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (c < 32) {
                        output.append("\\u00");
                        output.append(Character.forDigit(c >>> 4, 16));
                        output.append(Character.forDigit(c & 15, 16));
                    } else output.append(c);
                }
            }
        }
        output.append('"');
    }
}
