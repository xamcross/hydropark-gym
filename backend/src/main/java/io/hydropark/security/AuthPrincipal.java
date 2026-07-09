package io.hydropark.security;

import java.util.Collection;
import java.util.List;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.Authentication;

/** The authenticated caller: {@code sub} is the {@code users.id}. */
public record AuthPrincipal(String userId, boolean emailVerified) implements Authentication {

  @Override
  public Collection<? extends GrantedAuthority> getAuthorities() {
    return List.of(new SimpleGrantedAuthority("ROLE_USER"));
  }

  @Override
  public Object getCredentials() {
    return null;
  }

  @Override
  public Object getDetails() {
    return null;
  }

  @Override
  public Object getPrincipal() {
    return userId;
  }

  @Override
  public boolean isAuthenticated() {
    return true;
  }

  @Override
  public void setAuthenticated(boolean isAuthenticated) {
    if (!isAuthenticated) {
      throw new IllegalArgumentException("AuthPrincipal is always authenticated");
    }
  }

  @Override
  public String getName() {
    return userId;
  }
}
