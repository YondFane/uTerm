package qa;

import java.util.Arrays;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;

@SpringBootApplication
public class Application {
    public static void main(String[] args) throws Exception {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("STOP_MAVEN_CLEANUP");
            System.out.flush();
        }));
        ConfigurableApplicationContext context = SpringApplication.run(Application.class, args);
        Properties properties = new Properties();
        try (java.io.InputStream input = Application.class.getResourceAsStream("/qa.properties")) {
            properties.load(input);
        }
        System.out.println("READY_MAVEN:" + Library.value() + ":" + System.getenv("VALUE")
                + ":" + System.getProperty("qa.value"));
        System.out.println("PROFILES:" + String.join(",", context.getEnvironment().getActiveProfiles()));
        System.out.println("MAVEN_FLAGS:" + properties.getProperty("profile") + ":"
                + properties.getProperty("settings") + ":" + properties.getProperty("jvm"));
        for (String argument : args) System.out.println("ARG:" + argument + ":END");
        System.out.flush();
        if (Arrays.asList(args).contains("wait")) new CountDownLatch(1).await();
        context.close();
        System.out.println("FINAL_MAVEN:中文 e\u0301");
        System.err.println("FINAL_MAVEN_ERR:中文");
    }
}
