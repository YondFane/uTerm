package uterm.compat;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

public final class Java8EncodingAgent {
    public static void premain(String encoded, Instrumentation instrumentation) throws Exception {
        if (encoded == null || encoded.length() > 32 * 1024 * 1024 || encoded.length() % 2 != 0)
            throw new IllegalArgumentException("JAVA_UTF8_ARGUMENTS_INVALID");
        byte[] bytes = new byte[encoded.length() / 2];
        for (int i = 0; i < bytes.length; i++) {
            int high = Character.digit(encoded.charAt(i * 2), 16);
            int low = Character.digit(encoded.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IllegalArgumentException("JAVA_UTF8_ARGUMENTS_INVALID");
            bytes[i] = (byte) ((high << 4) | low);
        }
        String[] values = new String(bytes, StandardCharsets.UTF_8).split("\u0000", -1);
        if (values.length < 6 || !values[0].equals("1"))
            throw new IllegalArgumentException("JAVA_UTF8_ARGUMENTS_INVALID");
        Charset nativeEncoding = Charset.forName(System.getProperty("sun.jnu.encoding"));
        List<String> roots = new ArrayList<String>(Arrays.asList(values[1], values[2], values[3]));
        String path = System.getenv("PATH");
        if (path != null) roots.addAll(Arrays.asList(path.split(Pattern.quote(File.pathSeparator))));
        for (String property : new String[]{"java.home", "sun.boot.library.path", "sun.boot.class.path", "java.library.path", "java.ext.dirs", "java.endorsed.dirs"}) {
            String value = System.getProperty(property);
            if (value == null) continue;
            for (String root : roots) {
                if (root.isEmpty()) continue;
                String wrong = new String(root.getBytes(StandardCharsets.UTF_8), nativeEncoding);
                if (!wrong.equals(root)) value = value.replace(wrong, root);
            }
            System.setProperty(property, value);
        }
        System.setProperty("user.dir", values[2]);
        System.setProperty("sun.java.command", values[5]);
        // Restore original property values before later agents or the application can observe them.
        // 在后续 Agent 或应用能够读取属性之前，恢复原始属性值。
        for (int i = 6; i < values.length; i++) {
            int equals = values[i].indexOf('=');
            if (equals <= 0) throw new IllegalArgumentException("JAVA_UTF8_ARGUMENTS_INVALID");
            System.setProperty(values[i].substring(0, equals), values[i].substring(equals + 1));
        }
        List<String> entries = new ArrayList<String>();
        for (String entry : values[4].split(Pattern.quote(File.pathSeparator), -1)) {
            File file = new File(entry.isEmpty() ? "." : entry);
            if (file.getName().equals("*")) {
                int previous = entries.size();
                File parent = file.getParentFile();
                File[] children = (parent == null ? new File(".") : parent).listFiles();
                if (children != null) for (File child : children) {
                    if (child.isFile() && child.getName().toLowerCase(Locale.ROOT).endsWith(".jar"))
                        entries.add(child.getPath());
                }
                if (entries.size() == previous) entries.add(entry);
            } else entries.add(entry);
        }
        StringBuilder classpath = new StringBuilder();
        List<URL> urls = new ArrayList<URL>();
        for (int i = 0; i < entries.size(); i++) {
            String entry = entries.get(i);
            if (i > 0) classpath.append(File.pathSeparator);
            classpath.append(entry);
            urls.add(new File(entry.isEmpty() ? "." : entry).toURI().toURL());
        }
        ClassLoader loader = ClassLoader.getSystemClassLoader();
        if (loader instanceof URLClassLoader) {
            // Replace the preinitialized, misdecoded URL list; keep the selected JDK's loader and parent.
            // 替换提前初始化且解码错误的 URL 列表，保留所选 JDK 的加载器及父加载器。
            Object paths = Class.forName("sun.misc.URLClassPath").getConstructor(URL[].class)
                .newInstance((Object) urls.toArray(new URL[urls.size()]));
            Field field = URLClassLoader.class.getDeclaredField("ucp");
            field.setAccessible(true);
            field.set(loader, paths);
        } else if (!classpath.toString().equals(System.getProperty("java.class.path"))) {
            throw new IllegalStateException("JAVA_UTF8_CLASSLOADER_UNSUPPORTED");
        }
        System.setProperty("java.class.path", classpath.toString());
        System.setProperty("sun.jnu.encoding", "UTF-8");
        for (String name : new String[]{"sys_paths", "usr_paths"}) {
            Field field = ClassLoader.class.getDeclaredField(name);
            field.setAccessible(true);
            field.set(null, null);
        }
    }
}
