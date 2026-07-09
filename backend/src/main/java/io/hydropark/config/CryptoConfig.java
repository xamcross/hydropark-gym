package io.hydropark.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * Crypto primitives that are not web concerns.
 *
 * <p>Deliberately separate from {@link SecurityConfig}, which is gated on a servlet web application:
 * hashing a password has nothing to do with having an HTTP stack, and the one-shot {@code migrate}
 * job (and any future non-web zone) must still be able to construct the auth services.
 */
@Configuration
public class CryptoConfig {

  /**
   * Argon2id. Passwords are optional in this product - device-only and OAuth-only accounts carry a
   * null hash - but where one exists it must be expensive to crack.
   */
  @Bean
  PasswordEncoder passwordEncoder() {
    return Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();
  }
}
